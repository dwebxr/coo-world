import { handlePhysicsFailure } from '../extras/physicsFailure.js'
import * as THREE from '../extras/three'
import { isNumber } from 'lodash-es'

import { System } from './System'
import { LooseOctree } from '../extras/LooseOctree'
import { serializeError } from '../extras/serializeError'
import { NODE_CLIMB_LIMIT } from '../extras/nodeLimits.js'
import { hardenForScripts } from '../extras/scriptHardening'

const vec2 = new THREE.Vector2()

// A linked instance's matrix is its node's own matrixWorld, which scripts hold. InstancedMesh.setMatrixAt would call
// that object's toArray (a script could define one) and hand it the shared instance buffer. Instead the values are
// read with the class's own method into an array of the caller's own (node matrices are sealed, with typed elements,
// so no script code runs while they are read: sealMath.js), kept only if they are numbers, and written into the buffer
// by the host. Every read that is outstanding at once uses its own array (a read nested inside another, should one
// ever run script code, cannot overwrite the values the outer one has), and callers still check their bookkeeping
// after the read.
const toArray = THREE.Matrix4.prototype.toArray
const copyMatrix = THREE.Matrix4.prototype.copy
const matrixArrays = [] // one per nesting depth, made on first use
let matrixDepth = 0

function readMatrix(matrix) {
  const values = (matrixArrays[matrixDepth] ??= new Float64Array(16))
  matrixDepth++
  try {
    toArray.call(matrix, values, 0)
  } finally {
    matrixDepth--
  }
  return values
}

function writeMatrix(iMesh, idx, values) {
  const array = iMesh.instanceMatrix.array
  // (a slot past the buffer is written when clean() grows it)
  if (idx * 16 + 16 <= array.length) array.set(values, idx * 16)
}

// what a material facade passes to the renderer, which reads it every frame for every app: primitives only (a boxed
// Number or an object with its own valueOf would run script code inside the renderer)
function materialNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`[material] ${name} not a number`)
  return value
}
const CLEAN_RETRY_CAP = 10
// a Model with no instances is released after this long (world time), so a visible toggle or an LOD switch keeps it
const MODEL_IDLE_SECONDS = 10
// linked materials kept beyond their Model; past this, the oldest ones whose Model is gone are disposed (geometry
// variants such as a box Mesh's changing width would otherwise add one per variant)
// (a normal world creates a few hundred); a script that still holds the proxy of an evicted material keeps editing a
// material nothing renders, which only a churn of thousands of variants can cause
const LINKED_MATERIAL_LIMIT = 8192

/**
 * Stage System
 *
 * - Runs on both the server and client.
 * - Allows inserting meshes etc into the world, and providing a handle back.
 * - Automatically handles instancing/batching.
 * - This is a logical scene graph, no rendering etc is handled here.
 *
 */
export class Stage extends System {
  constructor(world) {
    super(world)
    this.scene = new THREE.Scene()
    this.models = new Map() // id -> Model
    // id -> the material a Model renders with; it outlives the Model, so a rebuilt Model reuses it and scripts' material
    // proxies (and their edits) stay valid. Bounded by the loaded models' materials and the prim material cap.
    this.linkedMaterials = new Map()
    this.linkedMaterialLimit = LINKED_MATERIAL_LIMIT
    this.octree = new LooseOctree({
      scene: this.scene,
      center: new THREE.Vector3(0, 0, 0),
      size: 10,
    })
    this.defaultMaterial = null
    this.raycaster = new THREE.Raycaster()
    this.raycaster.firstHitOnly = true
    this.raycastHits = []
    this.maskNone = new THREE.Layers()
    this.maskNone.enableAll()
    this.dirtyNodes = new Set()
  }

  init({ viewport }) {
    this.viewport = viewport
    this.scene.add(this.world.rig)
  }

  update(delta) {
    this.models.forEach(model => model.clean())
  }

  postUpdate() {
    this.clean() // after update all matrices should be up to date for next step
  }

  postLateUpdate() {
    this.clean() // after lateUpdate all matrices should be up to date for next step
  }

  getDefaultMaterial() {
    if (!this.defaultMaterial) {
      this.defaultMaterial = this.createMaterial()
    }
    return this.defaultMaterial
  }

  clean() {
    let failed
    for (const node of this.dirtyNodes) {
      try {
        node.clean()
        if (node._cleanFailures) node._cleanFailures = 0
      } catch (err) {
        if (!failed) failed = []
        failed.push({ node, err })
      }
    }
    this.dirtyNodes.clear()
    if (failed) this.containCleanFailures(failed)
  }

  // A node whose update throws (eg a script put a throwing valueOf into its transform) must not stop
  // every other node from updating. App-owned nodes crash their app, which unbuilds the whole subtree.
  // Other nodes are retried on the next pass, up to CLEAN_RETRY_CAP consecutive failures; after that the
  // node is left untracked until a later write tracks it again.
  // A failed Node.clean() may have consumed transform flags part-way through its subtree, so a retry
  // re-tracks the top of that traversal with the whole subtree marked transformed (full recompute), and
  // giving up recomputes what it can before releasing the flags, so later writes find consistent matrices.
  // NOTE: until the shared THREE prototypes are hardened, the failing code may be another app's patch.
  containCleanFailures(failed) {
    const crashed = new Set()
    for (const { node, err } of failed) {
      const owner = node.ctx?.entity
      const trapped = handlePhysicsFailure(err, { entity: owner, world: this.world, phase: 'Stage.clean' })
      try {
        if (!node._cleanFailed) {
          node._cleanFailed = true
          console.error(`[stage] node update failed (node ${node.id}, entity ${owner?.data?.id ?? 'none'})`)
          console.error(err)
        }
        if (owner?.isApp && !crashed.has(owner)) owner.scriptError = serializeError(err)
      } catch {
        // a hostile error object (eg throwing getters) must not stop the containment itself
      }
      if (owner?.isApp) {
        if (crashed.has(owner)) continue
        crashed.add(owner)
        if (!trapped) owner.crash()
        continue
      }
      // the traversal that failed started at the top of the dirty chain, like Node.clean(); the climb is bounded
      // (a parent chain that long can only be a corrupted, cyclic graph, and then the node itself is the top)
      let top = node
      let steps = 0
      while (top.parent && top.parent.isDirty) {
        if (++steps > NODE_CLIMB_LIMIT) {
          top = node
          break
        }
        top = top.parent
      }
      node._cleanFailures = (node._cleanFailures || 0) + 1
      if (node._cleanFailures >= CLEAN_RETRY_CAP) {
        if (!node._cleanGaveUp) {
          node._cleanGaveUp = true
          console.error(
            `[stage] giving up on node ${node.id} (entity ${owner?.data?.id ?? 'none'}) after ${CLEAN_RETRY_CAP} failures`
          )
        }
        node._cleanFailures = 0
        try {
          top.traverse(child => {
            try {
              child.updateTransform()
            } catch {
              // stays stale until its next write
            }
            child.isDirty = false
            child.isTransformed = false
            this.dirtyNodes.delete(child)
          })
        } catch {
          // a cyclic subtree overflows the walk; what was reached is released
        }
        continue
      }
      try {
        top.traverse(child => {
          child.isTransformed = true
          child.isDirty = true
          this.dirtyNodes.delete(child)
        })
      } catch {
        // a cyclic subtree overflows the walk; the retry below fails again and counts towards giving up
      }
      this.dirtyNodes.add(top)
    }
  }

  insert(options) {
    if (options.linked) {
      return this.insertLinked(options)
    } else {
      return this.insertSingle(options)
    }
  }

  insertLinked({ geometry, material, uberShader, castShadow, receiveShadow, node, matrix }) {
    // canonical flags, so a boxed boolean cannot mint Model or material keys through its own toString
    uberShader = uberShader === true
    castShadow = castShadow === true
    receiveShadow = receiveShadow === true
    const id = `${geometry.uuid}/${material.uuid}/${uberShader}/${castShadow}/${receiveShadow}`
    if (!this.models.has(id)) {
      const model = new Model(
        this,
        id,
        geometry,
        this.linkedMaterial(id, material, uberShader),
        uberShader,
        castShadow,
        receiveShadow
      )
      this.models.set(id, model)
      // after the new Model is registered, so its own material is never the one trimmed
      this.trimLinkedMaterials()
    }
    return this.models.get(id).create(node, matrix)
  }

  // the uber-shader hook is installed once per material, when it is first created (a rebuilt Model must not wrap it
  // again: the wrapped hook re-declares the instance attributes and the shader fails to compile)
  linkedMaterial(id, raw, uberShader) {
    let material = this.linkedMaterials.get(id)
    if (!material) {
      material = this.createMaterial({ raw })
      if (uberShader) installUberShader(material.raw)
      this.linkedMaterials.set(id, material)
    }
    return material
  }

  // oldest first (Map order); a material whose Model still exists is kept, so the bound is the limit or the live
  // Models, whichever is larger
  trimLinkedMaterials() {
    if (this.linkedMaterials.size <= this.linkedMaterialLimit) return
    for (const [id, material] of this.linkedMaterials) {
      if (this.linkedMaterials.size <= this.linkedMaterialLimit) break
      if (this.models.has(id)) continue
      disposeMaterial(material)
      this.linkedMaterials.delete(id)
    }
  }

  insertSingle({ geometry, material, castShadow, receiveShadow, node, matrix }) {
    material = this.createMaterial({ raw: material })
    const mesh = new THREE.Mesh(geometry, material.raw)
    mesh.castShadow = castShadow
    mesh.receiveShadow = receiveShadow
    mesh.matrixWorld.copy(matrix)
    mesh.matrixAutoUpdate = false
    mesh.matrixWorldAutoUpdate = false
    const sItem = {
      matrix,
      geometry,
      material: material.raw,
      getEntity: () => node.ctx.entity,
      node,
    }
    this.scene.add(mesh)
    // a failed insert (a non-finite matrix) takes the mesh and its cloned material back out, so nothing renders a
    // geometry its node no longer holds
    try {
      this.octree.insert(sItem)
    } catch (err) {
      this.octree.remove(sItem)
      this.scene.remove(mesh)
      disposeMaterial(material)
      throw err
    }
    return {
      material: material.proxy,
      move: matrix => {
        mesh.matrixWorld.copy(matrix)
        this.octree.move(sItem)
      },
      destroy: () => {
        this.scene.remove(mesh)
        this.octree.remove(sItem)
        // the material and its textures were cloned for this mesh only (GPU textures are shared per Source and
        // refcounted by three, so disposing a clone frees nothing another material uses)
        disposeMaterial(material)
      },
    }
  }

  createMaterial(options = {}) {
    const self = this
    const material = {}
    let raw
    if (options.raw) {
      raw = options.raw.clone()
      raw.onBeforeCompile = options.raw.onBeforeCompile
    } else if (options.unlit) {
      raw = new THREE.MeshBasicMaterial({
        color: options.color || 'white',
      })
    } else {
      raw = new THREE.MeshStandardMaterial({
        color: options.color || 'white',
        metalness: isNumber(options.metalness) ? options.metalness : 0,
        roughness: isNumber(options.roughness) ? options.roughness : 1,
      })
    }
    raw.shadowSide = THREE.BackSide // fix csm shadow banding
    const textures = []
    if (raw.map) {
      raw.map = raw.map.clone()
      textures.push(raw.map)
    }
    if (raw.emissiveMap) {
      raw.emissiveMap = raw.emissiveMap.clone()
      textures.push(raw.emissiveMap)
    }
    if (raw.normalMap) {
      raw.normalMap = raw.normalMap.clone()
      textures.push(raw.normalMap)
    }
    if (raw.bumpMap) {
      raw.bumpMap = raw.bumpMap.clone()
      textures.push(raw.bumpMap)
    }
    if (raw.roughnessMap) {
      raw.roughnessMap = raw.roughnessMap.clone()
      textures.push(raw.roughnessMap)
    }
    if (raw.metalnessMap) {
      raw.metalnessMap = raw.metalnessMap.clone()
      textures.push(raw.metalnessMap)
    }
    this.world.setupMaterial(raw)
    const proxy = {
      get id() {
        return raw.uuid
      },
      get textureX() {
        return textures[0]?.offset.x
      },
      set textureX(val) {
        val = materialNumber(val, 'textureX')
        for (const tex of textures) {
          tex.offset.x = val
        }
        raw.needsUpdate = true
      },
      get textureY() {
        return textures[0]?.offset.y
      },
      set textureY(val) {
        val = materialNumber(val, 'textureY')
        for (const tex of textures) {
          tex.offset.y = val
        }
        raw.needsUpdate = true
      },
      // a new Color with the material's numbers: the renderer's own Color stays private (it is read every frame, and
      // a linked material is shared by every app that uses it); change the colour by assigning a string
      get color() {
        return new THREE.Color(raw.color.r, raw.color.g, raw.color.b)
      },
      set color(val) {
        if (typeof val !== 'string') {
          throw new Error('[material] color must be a string (e.g. "red", "#ff0000", "rgb(255,0,0)")')
        }
        raw.color.set(val)
        raw.needsUpdate = true
      },
      get emissiveIntensity() {
        return raw.emissiveIntensity
      },
      set emissiveIntensity(value) {
        raw.emissiveIntensity = materialNumber(value, 'emissiveIntensity')
        raw.needsUpdate = true
      },
      get fog() {
        return raw.fog
      },
      set fog(value) {
        if (typeof value !== 'boolean') throw new Error('[material] fog not a boolean')
        raw.fog = value
        raw.needsUpdate = true
      },
      // TODO: not yet
      // clone() {
      //   return self.createMaterial(options).proxy
      // },
      get _ref() {
        if (self.world._allowMaterial) return material
        return undefined
      },
    }
    material.raw = raw
    // frozen, with its accessor functions: a linked material hands the same facade to every app that uses it,
    // so nothing on it may be redefined or used to pass data between scripts. The setters keep working.
    material.proxy = hardenForScripts(proxy)
    material.textures = textures
    return material
  }

  raycastPointer(position, layers = this.maskNone, min = 0, max = Infinity) {
    if (!this.viewport) throw new Error('no viewport')
    const rect = this.viewport.getBoundingClientRect()
    vec2.x = ((position.x - rect.left) / rect.width) * 2 - 1
    vec2.y = -((position.y - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(vec2, this.world.camera)
    this.raycaster.layers = layers
    this.raycaster.near = min
    this.raycaster.far = max
    this.raycastHits.length = 0
    this.octree.raycast(this.raycaster, this.raycastHits)
    return this.raycastHits
  }

  raycastReticle(layers = this.maskNone, min = 0, max = Infinity) {
    if (!this.viewport) throw new Error('no viewport')
    vec2.x = 0
    vec2.y = 0
    this.raycaster.setFromCamera(vec2, this.world.camera)
    this.raycaster.layers = layers
    this.raycaster.near = min
    this.raycaster.far = max
    this.raycastHits.length = 0
    this.octree.raycast(this.raycaster, this.raycastHits)
    return this.raycastHits
  }

  raycast(origin, direction, layers = this.maskNone, min = 0, max = Infinity) {
    if (!this.viewport) throw new Error('no viewport')
    vec2.x = 0
    vec2.y = 0
    this.raycaster.set(origin, direction)
    this.raycaster.layers = layers
    this.raycaster.near = min
    this.raycaster.far = max
    this.raycastHits.length = 0
    this.octree.raycast(this.raycaster, this.raycastHits)
    return this.raycastHits
  }

  destroy() {
    for (const model of [...this.models.values()]) model.release()
    for (const material of this.linkedMaterials.values()) disposeMaterial(material)
    this.models.clear()
    this.linkedMaterials.clear()
  }
}

class Model {
  constructor(stage, id, geometry, material, uberShader, castShadow, receiveShadow) {
    this.id = id
    this.idleSince = null

    this.stage = stage
    this.geometry = geometry.clone() // important since uber shader needs unique buffer attributes
    this.material = material
    this.uberShader = uberShader
    this.castShadow = castShadow
    this.receiveShadow = receiveShadow

    if (!this.geometry.boundsTree) this.geometry.computeBoundsTree()

    // this.mesh = mesh.clone()
    // this.mesh.geometry.computeBoundsTree() // three-mesh-bvh
    // // this.mesh.geometry.computeBoundingBox() // spatial octree
    // // this.mesh.geometry.computeBoundingSphere() // spatial octree
    // this.mesh.material.shadowSide = THREE.BackSide // fix csm shadow banding
    // this.mesh.castShadow = true
    // this.mesh.receiveShadow = true
    // this.mesh.matrixAutoUpdate = false
    // this.mesh.matrixWorldAutoUpdate = false

    this.iMesh = new THREE.InstancedMesh(this.geometry, this.material.raw, 10)
    // this.iMesh.name = this.mesh.name
    this.iMesh.castShadow = this.castShadow
    this.iMesh.receiveShadow = this.receiveShadow
    this.iMesh.matrixAutoUpdate = false
    this.iMesh.matrixWorldAutoUpdate = false
    this.iMesh.frustumCulled = false
    this.iMesh.getEntity = this.getEntity.bind(this)
    this.items = [] // { idx, node, matrix, color }
    this.dirty = true
  }

  create(node, matrix) {
    this.idleSince = null
    // the values first (reading them can run script code), then the instance and its slot
    const values = readMatrix(matrix)
    const item = {
      idx: this.items.length,
      node,
      matrix,
      color: null,
      emissive: null,
      emissiveIntensity: null,
      // octree
    }
    this.items.push(item)
    writeMatrix(this.iMesh, item.idx, values) // a slot past the buffer is written when clean() grows it
    this.dirty = true
    const sItem = {
      matrix,
      geometry: this.geometry,
      material: this.material.raw,
      getEntity: () => this.items[item.idx]?.node.ctx.entity,
      node,
    }
    try {
      this.stage.octree.insert(sItem)
    } catch (err) {
      // the instance is taken back out, so the Model can still go idle
      this.stage.octree.remove(sItem)
      this.destroy(item)
      throw err
    }
    return {
      material: this.material.proxy,
      move: matrix => {
        this.move(item, matrix)
        this.stage.octree.move(sItem)
      },
      setColor: value => {
        if (!item.color) item.color = new THREE.Color()
        item.color.set(value)
        this.iMesh.setColorAt(item.idx, item.color)
        this.iMesh.instanceColor.needsUpdate = true
      },
      setEmissive: value => {
        if (!item.emissive) item.emissive = new THREE.Color()
        item.emissive.set(value)
        this.iMesh.setEmissiveAt(item.idx, item.emissive)
        this.iMesh.instanceEmissive.needsUpdate = true
      },
      setEmissiveIntensity: value => {
        item.emissiveIntensity = value
        this.iMesh.setEmissiveIntensityAt(item.idx, item.emissiveIntensity)
        this.iMesh.instanceEmissiveIntensity.needsUpdate = true
      },
      // (the octree entry goes even if taking the instance out throws, so a raycast never hits a removed node)
      destroy: () => {
        try {
          this.destroy(item)
        } finally {
          this.stage.octree.remove(sItem)
        }
      },
    }
  }

  // (the values are read first; they go to the instance's slot only if it is still there after that)
  move(item, matrix) {
    if (item.matrix !== matrix) copyMatrix.call(item.matrix, matrix)
    const values = readMatrix(matrix)
    if (this.items[item.idx] === item) writeMatrix(this.iMesh, item.idx, values)
    this.dirty = true
  }

  destroy(item) {
    const last = this.items[this.items.length - 1]
    const isOnly = this.items.length === 1
    const isLast = item === last
    if (isOnly) {
      this.items = []
      this.dirty = true
    } else if (isLast) {
      // this is the last instance in the buffer, pop it off the end
      this.items.pop()
      this.dirty = true
    } else {
      // there are other instances after this one in the buffer, swap it with the last one and pop it off the end. The
      // list is updated first; the moved instance's values are read after that (reading can run script code, which
      // can take more instances out or move this one) and written only if it is still the instance in that slot
      const idx = item.idx
      last.idx = idx
      this.items[idx] = last
      this.items.pop()
      this.dirty = true
      let values
      try {
        values = readMatrix(last.matrix)
      } catch (err) {
        // the slot must not keep showing the removed instance: it shows nothing until the moved one moves again
        if (this.items[idx] === last) this.iMesh.instanceMatrix.array.fill(0, idx * 16, idx * 16 + 16)
        throw err
      }
      if (this.items[idx] !== last) return
      writeMatrix(this.iMesh, idx, values)
      if (last.color) this.iMesh.setColorAt(idx, last.color)
      if (last.emissive) this.iMesh.setEmissiveAt(idx, last.emissive)
      if (last.emissiveIntensity || last.emissiveIntensity === 0) {
        this.iMesh.setEmissiveIntensityAt(idx, last.emissiveIntensity)
      }
    }
  }

  clean() {
    if (!this.items.length) {
      const now = this.stage.world.time ?? 0
      this.idleSince ??= now
      if (now - this.idleSince >= MODEL_IDLE_SECONDS) return this.release()
    }
    if (!this.dirty) return
    const size = this.iMesh.instanceMatrix.array.length / 16
    const count = this.items.length
    if (size < this.items.length) {
      const newSize = count + 100
      // console.log('increase', this.mesh.name, 'from', size, 'to', newSize)
      this.iMesh.resize(newSize)
      // (the list is read again after every read of a matrix, which can run script code)
      for (let i = size; i < this.items.length && i < newSize; i++) {
        const item = this.items[i]
        const values = readMatrix(item.matrix)
        if (this.items[i] !== item) continue
        writeMatrix(this.iMesh, i, values)
        if (item.color) this.iMesh.setColorAt(i, item.color)
        if (item.emissive) this.iMesh.setEmissiveAt(i, item.emissive)
        if (item.emissiveIntensity || item.emissiveIntensity === 0) {
          this.iMesh.setEmissiveIntensityAt(i, item.emissiveIntensity)
        }
      }
    }
    this.iMesh.count = this.items.length
    if (this.iMesh.parent && !this.items.length) {
      this.stage.scene.remove(this.iMesh)
      this.dirty = false
      return
    }
    if (!this.iMesh.parent && count) {
      this.stage.scene.add(this.iMesh)
    }
    this.iMesh.instanceMatrix.needsUpdate = true
    if (this.iMesh.instanceColor) {
      this.iMesh.instanceColor.needsUpdate = true
    }
    if (this.iMesh.instanceEmissive) {
      this.iMesh.instanceEmissive.needsUpdate = true
    }
    if (this.iMesh.instanceEmissiveIntensity) {
      this.iMesh.instanceEmissiveIntensity.needsUpdate = true
    }
    // this.iMesh.computeBoundingSphere()
    this.dirty = false
  }

  // releases what only this Model used: its instanced mesh, its geometry clone and the BVH. The material stays in
  // stage.linkedMaterials for a later Model with the same id.
  release() {
    if (this.iMesh.parent) this.stage.scene.remove(this.iMesh)
    this.iMesh.dispose()
    this.geometry.disposeBoundsTree?.()
    this.geometry.dispose()
    this.stage.models.delete(this.id)
    // its material is now trimmable, so a burst of variants that all expired comes back under the limit
    this.stage.trimLinkedMaterials()
  }

  getEntity(instanceId) {
    console.warn('TODO: remove if you dont ever see this')
    return this.items[instanceId]?.node.ctx.entity
  }

  getTriangles() {
    const geometry = this.geometry
    if (geometry.index !== null) {
      return geometry.index.count / 3
    } else {
      return geometry.attributes.position.count / 3
    }
  }
}

// uber shader extends to support more per-instance properties like emissive, emissiveIntensity and anything else in the
// future; installed once per linked material (Stage.linkedMaterial)
function installUberShader(raw) {
  const prev = raw.onBeforeCompile
  // see: https://claude.ai/chat/b73be3e5-bb52-4da2-a47e-fbbf4f3eb54b
  raw.onBeforeCompile = function (shader) {
    prev?.(shader)
    shader.vertexShader = shader.vertexShader.replace(
      `#include <color_pars_vertex>`,
      `
        #include <color_pars_vertex>
        #ifdef USE_UBER_SHADER
          attribute vec3 instanceEmissive;
          attribute float instanceEmissiveIntensity;
          varying vec3 vInstanceEmissive;
        #endif
        `
    )
    shader.vertexShader = shader.vertexShader.replace(
      `#include <color_vertex>`,
      `
        #include <color_vertex>
        #ifdef USE_UBER_SHADER
          vInstanceEmissive = instanceEmissive * instanceEmissiveIntensity;
        #endif
        `
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <color_pars_fragment>`,
      `
        #include <color_pars_fragment>
        #ifdef USE_UBER_SHADER
          varying vec3 vInstanceEmissive;
        #endif
        `
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      `vec3 totalEmissiveRadiance = emissive;`,
      `
        vec3 totalEmissiveRadiance = emissive;
        #ifdef USE_UBER_SHADER
          totalEmissiveRadiance = vInstanceEmissive;
        #endif
        `
    )
    // console.log(this)
    // console.log(shader.vertexShader)
    // console.log(shader.fragmentShader)
  }
  raw.defines.USE_UBER_SHADER = ''
  raw.needsUpdate = true
}

// a material made by Stage.createMaterial: its raw clone and the texture clones it carries
function disposeMaterial(material) {
  material.raw.dispose()
  for (const texture of material.textures) texture.dispose()
}
