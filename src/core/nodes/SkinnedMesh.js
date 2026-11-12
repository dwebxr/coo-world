import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'

import { Node } from './Node'
import * as THREE from '../extras/three'
import { scriptView, sealAll } from '../extras/sealMath.js'
import { toEngineNumber } from '../extras/engineNumber.js'
import { isBoolean } from '../extras/scriptPrimitives.js'

const defaults = {
  object3d: null,
  animations: [],
  castShadow: true,
  receiveShadow: true,
}

const m1 = new THREE.Matrix4()

const defaultStopOpts = { fade: 0.15 }

export class SkinnedMesh extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'skinnedmesh'

    this._object3d = data.object3d
    this._animations = data.animations

    this.castShadow = data.castShadow
    this.receiveShadow = data.receiveShadow

    this.clips = {}
    this.actions = {}
    this.bones = null
    this.animNames = []
    // by bone name, a script's string: no prototype, or `getBone('constructor')` found Object's own and handed it out
    this.boneHandles = Object.create(null)
  }

  mount() {
    this.clips = {}
    this.actions = {}
    this.bones = null
    this.animNames = []

    this.obj = SkeletonUtils.clone(this._object3d)
    this.obj.matrixWorld.copy(this.matrixWorld)
    this.obj.matrixAutoUpdate = false
    this.obj.matrixWorldAutoUpdate = false
    this.obj.traverse(n => {
      if (n.isMesh) {
        n.castShadow = this._castShadow
        n.receiveShadow = this._receiveShadow
      }
      // a bone's transform is what getBone() hands scripts (sealMath.js)
      if (n.isBone) sealAll(n.position, n.quaternion, n.rotation, n.scale, n.matrix, n.matrixWorld)
    })
    this.ctx.world.stage.scene.add(this.obj)
    for (const clip of this._animations) {
      this.clips[clip.name] = clip
      this.animNames.push(clip.name)
    }
    this.needsRebuild = false
  }

  commit(didMove) {
    if (this.needsRebuild) {
      this.remount()
    }
    if (didMove) {
      if (this.obj) {
        this.obj.matrixWorld.copy(this.matrixWorld)
      }
    }
  }

  unmount() {
    if (this.obj) {
      if (this.mixer) {
        this.mixer.stopAllAction()
        this.mixer.uncacheRoot(this.obj)
        this.mixer = null
        this.ctx.world.setHot(this, false)
        this.clips = {}
        this.actions = {}
      }
      // the action that played belonged to that mixer: kept, it made play() of the same clip return at once after a
      // remount ("already playing"), with nothing playing
      this.action = null
      this.ctx.world.stage.scene.remove(this.obj)
      // each mount clones the skeletons (mount: SkeletonUtils.clone), and a renderer makes a bone texture for each:
      // disposing the clone's frees it. Geometry and materials are the model's, shared with every other copy, and stay.
      this.obj.traverse(n => {
        if (n.isSkinnedMesh) n.skeleton?.dispose()
      })
      this.obj = null
      this.bones = null
      this.animNames = []
    }
  }

  // a shadow setting changed while mounted goes to the meshes of the mounted copy. The setters used to ask for a
  // rebuild when `this.handle` was set, which this class never sets: the change waited for the next mount. Nothing is
  // rebuilt for it: a rebuild would make a new copy, and the animation that plays belongs to this one.
  applyShadows() {
    this.obj?.traverse(n => {
      if (n.isMesh) {
        n.castShadow = this._castShadow
        n.receiveShadow = this._receiveShadow
      }
    })
  }

  update(delta) {
    this.mixer?.update(delta)
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._object3d = source._object3d
    this._animations = source._animations
    this._castShadow = source._castShadow
    this._receiveShadow = source._receiveShadow
    return this
  }

  get anims() {
    return this.animNames.slice()
  }

  get castShadow() {
    return this._castShadow
  }

  set castShadow(value = defaults.castShadow) {
    if (!isBoolean(value)) {
      throw new Error('[skinnedmesh] castShadow not a boolean')
    }
    if (this._castShadow === value) return
    this._castShadow = value
    this.applyShadows()
  }

  get receiveShadow() {
    return this._receiveShadow
  }

  set receiveShadow(value = defaults.receiveShadow) {
    if (!isBoolean(value)) {
      throw new Error('[skinnedmesh] receiveShadow not a boolean')
    }
    if (this._receiveShadow === value) return
    this._receiveShadow = value
    this.applyShadows()
  }

  // only a mounted skinned mesh animates (its mixer, and its place in world.hot, go with its unmount). The options are
  // read once, into primitives, before that is checked: a getter, a toString or a valueOf on them is script code, which
  // could end the run (an object used as a clip name would otherwise be converted after the check)
  play(opts) {
    const { name: rawName, fade: rawFade = 0.15, speed: rawSpeed, loop = true } = opts
    const name = typeof rawName === 'string' ? rawName : String(rawName)
    const fade = Number(rawFade)
    const speed = rawSpeed === undefined ? undefined : Number(rawSpeed)
    if (!this.mounted || !this.obj || !this.canMount()) return
    if (!this.mixer) {
      this.mixer = new THREE.AnimationMixer(this.obj)
      this.ctx.world.setHot(this, true)
    }
    if (this.action?._clip.name === name) {
      return
    }
    if (this.action) {
      this.action.fadeOut(fade)
    }
    this.action = Object.hasOwn(this.actions, name) ? this.actions[name] : undefined
    if (!this.action) {
      const clip = Object.hasOwn(this.clips, name) ? this.clips[name] : undefined
      if (!clip) return console.warn(`[skinnedmesh] animation not found: ${name}`)
      this.action = this.mixer.clipAction(clip)
      this.actions[name] = this.action
    }
    if (speed !== undefined) this.action.timeScale = speed
    this.action.clampWhenFinished = !loop
    this.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce)
    this.action.reset().fadeIn(fade).play()
  }

  stop(opts = defaultStopOpts) {
    const fade = Number(opts.fade)
    if (!this.action) return
    this.action.fadeOut(fade)
    this.action = null
  }

  readBone(name) {
    if (!this.obj) return null
    if (!this.bones) {
      // (by name, no prototype: `constructor` is a bone only if the model has one of that name)
      this.bones = Object.create(null)
      this.obj.traverse(obj => {
        if (obj.isBone) {
          this.bones[obj.name] = obj
        }
      })
    }
    const bone = this.bones[name]
    if (!bone) {
      console.warn(`[skinnedmesh] bone not found: ${name}`)
      return null
    }
    return bone
  }

  getBone(name) {
    let handle = this.boneHandles[name]
    if (!handle) {
      const self = this
      handle = {
        get position() {
          return scriptView(self.readBone(name)?.position)
        },
        get quaternion() {
          return scriptView(self.readBone(name)?.quaternion)
        },
        get rotation() {
          return scriptView(self.readBone(name)?.rotation)
        },
        get scale() {
          return scriptView(self.readBone(name)?.scale)
        },
        get matrixWorld() {
          const bone = self.readBone(name)
          if (!bone) return null
          if (self.isDirty) self.clean()
          bone.updateMatrixWorld(true)
          return scriptView(bone.matrixWorld)
        },
        set matrixWorld(mat) {
          // the entries are read once, by the engine's number rule (engineNumber.js), before the bone takes them:
          // the bone's matrix is the engine's, read by its skinning every frame
          const entries = []
          const source = mat?.elements
          for (let i = 0; i < 16; i++) entries.push(toEngineNumber(source?.[i]))
          const bone = self.readBone(name)
          if (!bone) return
          bone.matrixAutoUpdate = false
          bone.matrixWorldAutoUpdate = false
          bone.matrixWorld.fromArray(entries)
        },
      }
      this.boneHandles[name] = handle
    }
    return handle
  }

  // deprecated: use getBone(name).matrixWorld
  getBoneTransform(name) {
    const bone = this.readBone(name)
    if (!bone) return null
    // combine the skinned mesh's world matrix with the bone's world matrix
    // return m1.multiplyMatrices(this.matrixWorld, bone.matrixWorld)
    bone.updateMatrixWorld(true)
    return m1.copy(bone.matrixWorld)
  }

  getProxy() {
    const self = this
    if (!this.proxy) {
      let proxy = {
        get anims() {
          return self.anims
        },
        get castShadow() {
          return self.castShadow
        },
        set castShadow(value) {
          self.castShadow = value
        },
        get receiveShadow() {
          return self.receiveShadow
        },
        set receiveShadow(value) {
          self.receiveShadow = value
        },
        play(opts) {
          self.play(opts)
        },
        stop(opts) {
          self.stop(opts)
        },
        getBone(name) {
          return self.getBone(name)
        },
        getBoneTransform(name) {
          // a copy: the class method returns a module matrix shared by every skinned mesh of every app
          const matrix = self.getBoneTransform(name)
          return matrix ? new THREE.Matrix4().copy(matrix) : matrix
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy())) // inherit Node properties
      this.proxy = proxy
    }
    return this.proxy
  }
}
