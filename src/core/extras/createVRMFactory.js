import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'

import * as THREE from './three'
import { DEG2RAD } from './general'
import { getTrianglesFromGeometry } from './getTrianglesFromGeometry'
import { getTextureBytesFromMaterial } from './getTextureBytesFromMaterial'
import { Emotes } from './playerEmotes'
import { Modes } from './locomotionModes'
import { collectMouthBinds, createMouth } from './vrmMouth'

const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const q1 = new THREE.Quaternion()
const m1 = new THREE.Matrix4()

const FORWARD = new THREE.Vector3(0, 0, -1)

const DIST_MIN_RATE = 1 / 5 // 5 times per second
const DIST_MAX_RATE = 1 / 60 // 40 times per second
const DIST_MIN = 5 // <= 5m = max rate
const DIST_MAX = 60 // >= 60m = min rate

const MAX_GAZE_DISTANCE = 40

const material = new THREE.MeshBasicMaterial()

const AimAxis = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
  NEG_X: new THREE.Vector3(-1, 0, 0),
  NEG_Y: new THREE.Vector3(0, -1, 0),
  NEG_Z: new THREE.Vector3(0, 0, -1),
}

const UpAxis = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
  NEG_X: new THREE.Vector3(-1, 0, 0),
  NEG_Y: new THREE.Vector3(0, -1, 0),
  NEG_Z: new THREE.Vector3(0, 0, -1),
}

// The humanoid bones the runtime below cannot do without. A VRM may leave others out (the neck is optional in
// VRM 1.0); those are looked up where they are used and skipped when absent. Checked here, while the file is
// still loading, so an avatar the engine cannot drive fails its load with a reason instead of throwing from the
// frame loop of everyone who can see it. (What the player shows then is up to the player code: today it keeps
// its previous avatar, or none.)
const REQUIRED_BONES = ['hips', 'head', 'leftUpperArm', 'rightUpperArm']
// the bones that must also be in the skeleton the runtime drives (findBone looks them up there)
const SKELETON_BONES = ['hips', 'head']

function assertUsableVRM(glb) {
  const humanoid = glb?.userData?.vrm?.humanoid
  if (!humanoid) throw new Error('[avatar] not a VRM: no humanoid')
  const raw = humanoid._rawHumanBones?.humanBones
  const normalized = humanoid._normalizedHumanBones?.humanBones
  for (const name of REQUIRED_BONES) {
    if (!raw?.[name]?.node || !normalized?.[name]?.node) throw new Error(`[avatar] unusable VRM: no ${name} bone`)
  }
}

// The bone the runtime takes out of the scene and drives as the root of the skeleton: from the hips up, as long as
// the parent is a bone of that skeleton. (The order of the joints says nothing about it: a file may list the head
// first.) `hipsName` is the name the humanoid gives the hips bone.
function skeletonRoot(skeleton, hipsName) {
  const bones = new Set(skeleton.bones)
  let root = skeleton.getBoneByName(hipsName)
  while (root?.parent && bones.has(root.parent)) root = root.parent
  return root
}

// The runtime drives one skeleton: the first skinned mesh's (in traversal order, as create() finds it again in each
// clone). The mixer is bound to that mesh, findBone and the per-frame bone updates use that skeleton, and the root
// above its hips (skeletonRoot) is taken out of the scene. The other skinned meshes of a VRM usually have Skeleton
// objects of their own over the same bones; they are skinned as they are and not checked. What is assumed of the
// first one: it has bones; every bone is in the scene (a clone maps bones through the scene graph, so one outside it
// would come back missing and every frame would throw); the hips and head are found in it by the names the humanoid
// gives; and the head is below the root, so the bones that are aimed and looked up move with the avatar. Other
// bones of the skeleton may lie outside the root's tree (some files have stray bones): they stay in the scene and
// are not refused.
function assertUsableSkeleton(glb) {
  let first = null
  glb.scene.traverse(node => {
    if (!first && node.isSkinnedMesh) first = node
  })
  if (!first) throw new Error('[avatar] unusable VRM: no skinned mesh')
  const skeleton = first.skeleton
  const bones = skeleton?.bones
  if (!Array.isArray(bones) || bones.length === 0) {
    throw new Error('[avatar] unusable VRM: the skinned mesh has no bones')
  }
  const inScene = bone => {
    for (let node = bone; node; node = node.parent) if (node === glb.scene) return true
    return false
  }
  if (!bones.every(bone => bone?.isObject3D && inScene(bone))) {
    throw new Error('[avatar] unusable VRM: a bone of the skeleton is not in the scene')
  }
  const found = {}
  for (const name of SKELETON_BONES) {
    const boneName = glb.userData.vrm.humanoid.getRawBoneNode(name)?.name
    found[name] = boneName ? skeleton.getBoneByName(boneName) : undefined
    if (!found[name]) throw new Error(`[avatar] unusable VRM: the ${name} bone is not in the skeleton`)
  }
  const root = skeletonRoot(skeleton, found.hips.name)
  let below = false
  for (let node = found.head; node; node = node.parent) if (node === root) below = true
  if (!below) throw new Error('[avatar] unusable VRM: the head bone is not below the root of the skeleton')
}

// emote clips one avatar instance keeps mixed and ready; the least recently started leaves first
const EMOTE_LIMIT = 16

export function createVRMFactory(glb, setupMaterial) {
  assertUsableVRM(glb)
  // we'll update matrix ourselves
  glb.scene.matrixAutoUpdate = false
  glb.scene.matrixWorldAutoUpdate = false
  // remove expressions from scene
  const expressions = glb.scene.children.filter(n => n.type === 'VRMExpression') // prettier-ignore
  for (const node of expressions) node.removeFromParent()
  // remove VRMHumanoidRig
  const vrmHumanoidRigs = glb.scene.children.filter(n => n.name === 'VRMHumanoidRig') // prettier-ignore
  for (const node of vrmHumanoidRigs) node.removeFromParent()
  // remove secondary
  const secondaries = glb.scene.children.filter(n => n.name === 'secondary') // prettier-ignore
  for (const node of secondaries) node.removeFromParent()
  // after the removals: the scene checked is the one every instance clones
  assertUsableSkeleton(glb)
  // mouth binds by template traversal index; every instance resolves them against its own clone
  const mouthBinds = collectMouthBinds(glb.userData.vrm?.expressionManager, glb.scene)
  // enable shadows
  glb.scene.traverse(obj => {
    if (obj.isMesh) {
      obj.castShadow = true
      obj.receiveShadow = true
    }
  })
  // calculate root to hips
  const bones = glb.userData.vrm.humanoid._rawHumanBones.humanBones
  const hipsPosition = v1.setFromMatrixPosition(bones.hips.node.matrixWorld)
  const rootPosition = v2.set(0, 0, 0) //setFromMatrixPosition(bones.root.node.matrixWorld)
  const rootToHips = hipsPosition.y - rootPosition.y
  // get vrm version
  const version = glb.userData.vrm.meta?.metaVersion
  // convert skinned mesh to detached bind mode
  // this lets us remove root bone from scene and then only perform matrix updates on the whole skeleton
  // when we actually need to  for massive performance
  const skinnedMeshes = []
  glb.scene.traverse(node => {
    if (node.isSkinnedMesh) {
      node.bindMode = THREE.DetachedBindMode
      node.bindMatrix.copy(node.matrixWorld)
      node.bindMatrixInverse.copy(node.bindMatrix).invert()
      skinnedMeshes.push(node)
    }
    if (node.isMesh) {
      // bounds tree
      node.geometry.computeBoundsTree()
      // fix csm shadow banding
      node.material.shadowSide = THREE.BackSide
      // csm material setup
      setupMaterial(node.material)
    }
  })
  // remove root bone from scene
  // const rootBone = glb.scene.getObjectByName('RootBone')
  // console.log({ rootBone })
  // rootBone.parent.remove(rootBone)
  // rootBone.updateMatrixWorld(true)

  const skeleton = skinnedMeshes[0].skeleton // should be same across all skinnedMeshes

  // pose arms down
  const normBones = glb.userData.vrm.humanoid._normalizedHumanBones.humanBones
  const leftArm = normBones.leftUpperArm.node
  leftArm.rotation.z = 75 * DEG2RAD
  const rightArm = normBones.rightUpperArm.node
  rightArm.rotation.z = -75 * DEG2RAD
  glb.userData.vrm.humanoid.update(0)
  skeleton.update()

  // get height
  let height = 0.5 // minimum
  for (const mesh of skinnedMeshes) {
    if (!mesh.boundingBox) mesh.computeBoundingBox()
    if (height < mesh.boundingBox.max.y) {
      height = mesh.boundingBox.max.y
    }
  }

  // this.headToEyes = this.eyePosition.clone().sub(headPos)
  const headPos = normBones.head.node.getWorldPosition(new THREE.Vector3())
  const headToHeight = height - headPos.y

  const getBoneName = vrmBoneName => {
    return glb.userData.vrm.humanoid.getRawBoneNode(vrmBoneName)?.name
  }

  const noop = () => {
    // ...
  }

  return {
    create,
    applyStats(stats) {
      glb.scene.traverse(obj => {
        if (obj.geometry && !stats.geometries.has(obj.geometry.uuid)) {
          stats.geometries.add(obj.geometry.uuid)
          stats.triangles += getTrianglesFromGeometry(obj.geometry)
        }
        if (obj.material && !stats.materials.has(obj.material.uuid)) {
          stats.materials.add(obj.material.uuid)
          stats.textureBytes += getTextureBytesFromMaterial(obj.material)
        }
      })
    },
  }

  function create(matrix, hooks, node) {
    const vrm = cloneGLB(glb)
    // before the root bone leaves the clone: until then its traversal order matches the template
    const mouth = createMouth(vrm.scene, mouthBinds)
    const tvrm = vrm.userData.vrm
    const skinnedMeshes = getSkinnedMeshes(vrm.scene)
    const skeleton = skinnedMeshes[0].skeleton // should be same across all skinnedMeshes
    // the root above the hips (checked at load), not the first joint: the joints may be listed in any order
    const rootBone = skeletonRoot(skeleton, getBoneName('hips'))
    rootBone.parent.remove(rootBone)
    rootBone.updateMatrixWorld(true)
    vrm.scene.matrix = matrix // synced!
    vrm.scene.matrixWorld = matrix // synced!
    hooks.scene.add(vrm.scene)

    const getEntity = () => node?.ctx.entity

    // spatial capsule
    const cRadius = 0.3
    const sItem = {
      matrix,
      geometry: createCapsule(cRadius, height - cRadius * 2),
      material,
      getEntity,
    }
    hooks.octree?.insert(sItem)

    // debug capsule
    // const foo = new THREE.Mesh(
    //   sItem.geometry,
    //   new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 })
    // )
    // vrm.scene.add(foo)

    // link back entity for raycasts

    vrm.scene.traverse(o => {
      o.getEntity = getEntity
    })

    // i have no idea how but the mixer only needs one of the skinned meshes
    // and if i set it to vrm.scene it no longer works with detached bind mode
    const mixer = new THREE.AnimationMixer(skinnedMeshes[0])

    // a Map: the name can come from a script (getBoneTransform), and an object would answer 'constructor'.
    // A bone the avatar does not have is remembered as null, so the per-frame lookups stay cheap
    const bonesByName = new Map()
    const findBone = name => {
      // name is the official vrm bone name eg 'leftHand'
      // actualName is the actual bone name used in the skeleton which may different across vrms
      if (!bonesByName.has(name)) {
        const actualName = typeof name === 'string' ? glb.userData.vrm.humanoid.getRawBoneNode(name)?.name : undefined
        bonesByName.set(name, (actualName && skeleton.getBoneByName(actualName)) || null)
      }
      return bonesByName.get(name)
    }

    const mt = new THREE.Matrix4()
    const getBoneTransform = boneName => {
      const bone = findBone(boneName)
      if (!bone) return null
      // combine the scene's world matrix with the bone's world matrix
      return mt.multiplyMatrices(vrm.scene.matrixWorld, bone.matrixWorld)
    }

    const loco = {
      mode: Modes.IDLE,
      axis: new THREE.Vector3(),
      gazeDir: null,
    }
    const setLocomotion = (mode, axis, gazeDir) => {
      loco.mode = mode
      loco.axis = axis
      loco.gazeDir = gazeDir
    }

    // world.updater.add(update)
    // url -> { url, loading, action, gaze }, most recently started last, at most EMOTE_LIMIT (a remote player
    // chooses the urls: without a bound each new query string would add a clip and an action for good)
    const emotes = new Map()
    // stop() also hands back the fade's interpolant; uncacheAction() then releases the action and its bindings
    const forgetEmote = emote => {
      emotes.delete(emote.url)
      if (emote.action) {
        emote.action.stop()
        mixer.uncacheAction(emote.action.getClip())
      }
    }
    // set by destroy(): a clip that finishes loading afterwards is not mixed or played
    let destroyed = false
    let currentEmote
    const setEmote = url => {
      if (destroyed) return
      if (currentEmote?.url === url) return
      if (currentEmote) {
        currentEmote.action?.fadeOut(0.15)
        currentEmote = null
      }
      if (!url) return
      const opts = getQueryParams(url)
      const loop = opts.l !== '0'
      let speed = parseFloat(opts.s || 1)
      if (!Number.isFinite(speed) || speed < 0.01 || speed > 100) speed = 1
      const gaze = opts.g == '1'

      if (emotes.has(url)) {
        currentEmote = emotes.get(url)
        emotes.delete(url)
        emotes.set(url, currentEmote)
        if (currentEmote.action) {
          currentEmote.action.clampWhenFinished = !loop
          currentEmote.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce)
          currentEmote.action.reset().fadeIn(0.15).play()
          clearLocomotion()
        }
      } else {
        const emote = {
          url,
          loading: true,
          action: null,
          gaze,
        }
        emotes.set(url, emote)
        for (const old of emotes.values()) {
          if (emotes.size <= EMOTE_LIMIT) break
          if (old !== emote) forgetEmote(old)
        }
        currentEmote = emote
        hooks.loader
          .load('emote', url)
          .then(emo => {
            // dropped while it loaded (the limit), or the avatar is gone
            if (destroyed || emotes.get(url) !== emote) return
            const clip = emo.toClip({
              rootToHips,
              version,
              getBoneName,
            })
            const action = mixer.clipAction(clip)
            action.timeScale = speed
            emote.loading = false
            emote.action = action
            // if its still this emote, play it!
            if (currentEmote === emote) {
              action.clampWhenFinished = !loop
              action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce)
              action.play()
              clearLocomotion()
            }
          })
          .catch(err => {
            // an emote that cannot be loaded or retargeted: the avatar keeps its locomotion, and the url is
            // forgotten so a later request can try again
            if (emotes.get(url) === emote) emotes.delete(url)
            if (currentEmote === emote) currentEmote = null
            if (destroyed) return
            console.warn(`[avatar] emote failed: ${String(err?.message || err).slice(0, 120)}`)
          })
      }
    }

    // IDEA: we should use a global frame "budget" to distribute across avatars
    // https://chatgpt.com/c/4bbd469d-982e-4987-ad30-97e9c5ee6729

    let elapsed = 0
    let rate = 0
    let rateCheck = true
    let distance

    const updateRate = () => {
      const vrmPos = v1.setFromMatrixPosition(vrm.scene.matrix)
      const camPos = v2.setFromMatrixPosition(hooks.camera.matrixWorld) // prettier-ignore
      distance = vrmPos.distanceTo(camPos)
      const clampedDistance = Math.max(distance - DIST_MIN, 0)
      const normalizedDistance = Math.min(clampedDistance / (DIST_MAX - DIST_MIN), 1) // prettier-ignore
      rate = DIST_MAX_RATE + normalizedDistance * (DIST_MIN_RATE - DIST_MAX_RATE) // prettier-ignore
      // console.log('distance', distance)
      // console.log('rate per second', 1 / rate)
    }

    const update = delta => {
      elapsed += delta
      const should = rateCheck ? elapsed >= rate : true
      if (should) {
        mixer.update(elapsed)
        skeleton.bones.forEach(bone => bone.updateMatrixWorld())
        skeleton.update = THREE.Skeleton.prototype.update
        if (!currentEmote) {
          updateLocomotion(delta)
        }
        if (loco.gazeDir && distance < MAX_GAZE_DISTANCE && (currentEmote ? currentEmote.gaze : true)) {
          // aimBone('chest', loco.gazeDir, delta, {
          //   minAngle: -90,
          //   maxAngle: 90,
          //   smoothing: 0.7,
          //   weight: 0.7,
          // })
          aimBone('neck', loco.gazeDir, delta, {
            minAngle: -30,
            maxAngle: 30,
            smoothing: 0.4,
            weight: 0.6,
          })
          aimBone('head', loco.gazeDir, delta, {
            minAngle: -30,
            maxAngle: 30,
            smoothing: 0.4,
            weight: 0.6,
          })
        }
        // tvrm.humanoid.update(elapsed)
        elapsed = 0
      } else {
        skeleton.update = noop
      }
    }

    const aimBone = (() => {
      const smoothedRotations = new Map()
      const normalizedDir = new THREE.Vector3()
      const parentWorldMatrix = new THREE.Matrix4()
      const parentWorldRotationInverse = new THREE.Quaternion()
      const localDir = new THREE.Vector3()
      const currentAimDir = new THREE.Vector3()
      const rot = new THREE.Quaternion()
      const worldUp = new THREE.Vector3()
      const localUp = new THREE.Vector3()
      const rotatedUp = new THREE.Vector3()
      const projectedUp = new THREE.Vector3()
      const upCorrection = new THREE.Quaternion()
      const cross = new THREE.Vector3()
      const targetRotation = new THREE.Quaternion()
      const restToTarget = new THREE.Quaternion()

      return function aimBone(boneName, targetDir, delta, options = {}) {
        // default options
        const {
          aimAxis = AimAxis.NEG_Z,
          upAxis = UpAxis.Y,
          smoothing = 0.7, // smoothing factor (0-1)
          weight = 1.0,
          maintainOffset = false,
          minAngle = -180,
          maxAngle = 180,
        } = options
        // an avatar without this bone (the neck is optional) is simply not aimed there
        const bone = findBone(boneName)
        const parentBone = glb.userData.vrm.humanoid.humanBones[boneName]?.node?.parent
        if (!bone || !parentBone) return
        // get or create smoothed state for this bone
        const boneId = bone.uuid
        if (!smoothedRotations.has(boneId)) {
          smoothedRotations.set(boneId, {
            current: bone.quaternion.clone(),
            target: new THREE.Quaternion(),
          })
        }
        const smoothState = smoothedRotations.get(boneId)
        // normalize target direction
        normalizedDir.copy(targetDir).normalize()
        // get parent's world matrix
        parentWorldMatrix.multiplyMatrices(vrm.scene.matrixWorld, parentBone.matrixWorld)
        // extract parent's world rotation
        parentWorldMatrix.decompose(v1, parentWorldRotationInverse, v2)
        parentWorldRotationInverse.invert()
        // convert world direction to parent's local space
        localDir.copy(normalizedDir).applyQuaternion(parentWorldRotationInverse)
        // store initial offset if needed
        if (maintainOffset && !bone.userData.initialRotationOffset) {
          bone.userData.initialRotationOffset = bone.quaternion.clone()
        }
        // calc rotation needed to align aimAxis with localDir
        currentAimDir.copy(aimAxis)
        if (maintainOffset && bone.userData.initialRotationOffset) {
          currentAimDir.applyQuaternion(bone.userData.initialRotationOffset)
        }
        // create rotation
        rot.setFromUnitVectors(aimAxis, localDir)
        // get up direction in parent's local space
        worldUp.copy(upAxis)
        localUp.copy(worldUp).applyQuaternion(parentWorldRotationInverse)
        // apply up axis correction
        rotatedUp.copy(upAxis).applyQuaternion(rot)
        projectedUp.copy(localUp)
        projectedUp.sub(v1.copy(localDir).multiplyScalar(localDir.dot(localUp)))
        projectedUp.normalize()
        if (projectedUp.lengthSq() > 0.001) {
          upCorrection.setFromUnitVectors(rotatedUp, projectedUp)
          const angle = rotatedUp.angleTo(projectedUp)
          cross.crossVectors(rotatedUp, projectedUp)
          if (cross.dot(localDir) < 0) {
            upCorrection.setFromAxisAngle(localDir, -angle)
          } else {
            upCorrection.setFromAxisAngle(localDir, angle)
          }
          rot.premultiply(upCorrection)
        }
        // apply initial offset if maintaining it
        targetRotation.copy(rot)
        if (maintainOffset && bone.userData.initialRotationOffset) {
          targetRotation.multiply(bone.userData.initialRotationOffset)
        }
        // apply angle limits
        if (minAngle > -180 || maxAngle < 180) {
          if (!bone.userData.restRotation) {
            bone.userData.restRotation = bone.quaternion.clone()
          }
          restToTarget.copy(bone.userData.restRotation).invert().multiply(targetRotation)
          const w = restToTarget.w
          const angle = 2 * Math.acos(Math.min(Math.max(w, -1), 1))
          const angleDeg = THREE.MathUtils.radToDeg(angle)
          if (angleDeg > maxAngle || angleDeg < minAngle) {
            const clampedAngleDeg = THREE.MathUtils.clamp(angleDeg, minAngle, maxAngle)
            const clampedAngleRad = THREE.MathUtils.degToRad(clampedAngleDeg)
            const scale = clampedAngleRad / angle
            q1.copy(targetRotation)
            targetRotation.slerpQuaternions(bone.userData.restRotation, q1, scale)
          }
        }
        // apply weight
        if (weight < 1.0) {
          targetRotation.slerp(bone.quaternion, 1.0 - weight)
        }
        // update smooth state target
        smoothState.target.copy(targetRotation)
        // smoothly interpolate from current to target
        smoothState.current.slerp(smoothState.target, smoothing)
        // apply smoothed rotation to bone
        bone.quaternion.copy(smoothState.current)
        bone.updateMatrixWorld(true)
      }
    })()

    // position target equivalent of aimBone()
    const aimBoneDir = new THREE.Vector3()
    function aimBoneAt(boneName, targetPos, delta, options = {}) {
      const bone = findBone(boneName)
      if (!bone) return console.warn(`aimBone: missing bone (${boneName})`)
      const boneWorldMatrix = getBoneTransform(boneName)
      const boneWorldPos = v1.setFromMatrixPosition(boneWorldMatrix)
      aimBoneDir.subVectors(targetPos, boneWorldPos).normalize()
      aimBone(boneName, aimBoneDir, delta, options)
    }

    // hooks.loader.load('emote', 'asset://rifle-aim.glb').then(emo => {
    //   const clip = emo.toClip({
    //     rootToHips,
    //     version,
    //     getBoneName,
    //   })
    //   // THREE.AnimationUtils.makeClipAdditive(clip, 0, clipI)
    //   // clip.blendMode = THREE.AdditiveAnimationBlendMode
    //   const action = mixer.clipAction(clip)
    //   action.setLoop(THREE.LoopRepeat)
    //   action.setEffectiveWeight(6)
    //   action.reset().fadeIn(0.1).play()
    //   console.log('hi2')
    // })

    const poses = {}
    function addPose(key, url) {
      const opts = getQueryParams(url)
      let speed = parseFloat(opts.s || 1)
      if (!Number.isFinite(speed) || speed < 0.01 || speed > 100) speed = 1
      const pose = {
        loading: true,
        active: false,
        action: null,
        weight: 0,
        target: 0,
        setWeight: value => {
          pose.weight = value
          if (pose.action) {
            pose.action.weight = value
            if (!pose.active) {
              pose.action.reset().fadeIn(0.15).play()
              pose.active = true
            }
          }
        },
        fadeOut: () => {
          pose.weight = 0
          pose.action?.fadeOut(0.15)
          pose.active = false
        },
      }
      hooks.loader
        .load('emote', url)
        .then(emo => {
          if (destroyed) return
          const clip = emo.toClip({
            rootToHips,
            version,
            getBoneName,
          })
          pose.action = mixer.clipAction(clip)
          pose.action.timeScale = speed
          pose.action.weight = pose.weight
          pose.action.play()
        })
        .catch(err => {
          // the pose stays without an action (setWeight and fadeOut cope with that)
          if (destroyed) return
          console.warn(`[avatar] locomotion clip failed (${key}): ${String(err?.message || err).slice(0, 120)}`)
        })
      poses[key] = pose
    }
    addPose('idle', Emotes.IDLE)
    addPose('walk', Emotes.WALK)
    addPose('walkLeft', Emotes.WALK_LEFT)
    addPose('walkBack', Emotes.WALK_BACK)
    addPose('walkRight', Emotes.WALK_RIGHT)
    addPose('run', Emotes.RUN)
    addPose('runLeft', Emotes.RUN_LEFT)
    addPose('runBack', Emotes.RUN_BACK)
    addPose('runRight', Emotes.RUN_RIGHT)
    addPose('jump', Emotes.JUMP)
    addPose('fall', Emotes.FALL)
    addPose('fly', Emotes.FLY)
    addPose('talk', Emotes.TALK)
    function clearLocomotion() {
      for (const key in poses) {
        poses[key].fadeOut()
      }
    }
    function updateLocomotion(delta) {
      const { mode, axis } = loco
      for (const key in poses) {
        poses[key].target = 0
      }
      if (mode === Modes.IDLE) {
        poses.idle.target = 1
      } else if (mode === Modes.WALK || mode === Modes.RUN) {
        const angle = Math.atan2(axis.x, -axis.z)
        const angleDeg = ((angle * 180) / Math.PI + 360) % 360
        const prefix = mode === Modes.RUN ? 'run' : 'walk'
        const forwardKey = prefix // This should be "walk" or "run"
        const leftKey = `${prefix}Left`
        const backKey = `${prefix}Back`
        const rightKey = `${prefix}Right`
        if (axis.length() > 0.01) {
          if (angleDeg >= 337.5 || angleDeg < 22.5) {
            // Pure forward
            poses[forwardKey].target = 1
          } else if (angleDeg >= 22.5 && angleDeg < 67.5) {
            // Forward-right blend
            const blend = (angleDeg - 22.5) / 45
            poses[forwardKey].target = 1 - blend
            poses[rightKey].target = blend
          } else if (angleDeg >= 67.5 && angleDeg < 112.5) {
            // Pure right
            poses[rightKey].target = 1
          } else if (angleDeg >= 112.5 && angleDeg < 157.5) {
            // Right-back blend
            const blend = (angleDeg - 112.5) / 45
            poses[rightKey].target = 1 - blend
            poses[backKey].target = blend
          } else if (angleDeg >= 157.5 && angleDeg < 202.5) {
            // Pure back
            poses[backKey].target = 1
          } else if (angleDeg >= 202.5 && angleDeg < 247.5) {
            // Back-left blend
            const blend = (angleDeg - 202.5) / 45
            poses[backKey].target = 1 - blend
            poses[leftKey].target = blend
          } else if (angleDeg >= 247.5 && angleDeg < 292.5) {
            // Pure left
            poses[leftKey].target = 1
          } else if (angleDeg >= 292.5 && angleDeg < 337.5) {
            // Left-forward blend
            const blend = (angleDeg - 292.5) / 45
            poses[leftKey].target = 1 - blend
            poses[forwardKey].target = blend
          }
        }
      } else if (mode === Modes.JUMP) {
        poses.jump.target = 1
      } else if (mode === Modes.FALL) {
        poses.fall.target = 1
      } else if (mode === Modes.FLY) {
        poses.fly.target = 1
      } else if (mode === Modes.TALK) {
        poses.talk.target = 1
      }
      const lerpSpeed = 16
      for (const key in poses) {
        const pose = poses[key]
        const weight = THREE.MathUtils.lerp(pose.weight, pose.target, 1 - Math.exp(-lerpSpeed * delta))
        pose.setWeight(weight)
      }
    }

    // console.log('=== vrm ===')
    // console.log('vrm', vrm)
    // console.log('skeleton', skeleton)

    let firstPersonActive = false
    const setFirstPerson = active => {
      if (firstPersonActive === active) return
      // hide from the neck up; an avatar without a neck bone hides its head
      const head = findBone('neck') || findBone('head')
      if (head) head.scale.setScalar(active ? 0 : 1)
      firstPersonActive = active
    }

    return {
      raw: vrm,
      height,
      headToHeight,
      setEmote,
      setFirstPerson,
      update,
      updateRate,
      getBoneTransform,
      setLocomotion,
      setVisible(visible) {
        vrm.scene.traverse(o => {
          o.visible = visible
        })
      },
      move(_matrix) {
        matrix.copy(_matrix)
        hooks.octree?.move(sItem)
      },
      disableRateCheck() {
        rateCheck = false
      },
      // 0..1, applied now rather than on the throttled update
      setMouth(value) {
        mouth.set(value)
      },
      destroy() {
        if (destroyed) return
        destroyed = true
        // clips still loading are dropped when they arrive (see `destroyed`); the mixed ones are stopped and the
        // mixer lets go of their actions, bindings and clips
        for (const emote of [...emotes.values()]) forgetEmote(emote)
        currentEmote = null
        mixer.stopAllAction()
        mixer.uncacheRoot(mixer.getRoot())
        for (const key in poses) poses[key].action = null
        mouth.dispose()
        hooks.scene.remove(vrm.scene)
        // world.updater.remove(update)
        hooks.octree?.remove(sItem)
      },
    }
  }
}

function cloneGLB(glb) {
  // returns a shallow clone of the gltf but a deep clone of the scene.
  // uses SkeletonUtils.clone which is the same as Object3D.clone except also clones skinned meshes etc
  return { ...glb, scene: SkeletonUtils.clone(glb.scene) }
}

function getSkinnedMeshes(scene) {
  let meshes = []
  scene.traverse(o => {
    if (o.isSkinnedMesh) {
      meshes.push(o)
    }
  })
  return meshes
}

function createCapsule(radius, height) {
  const fullHeight = radius + height + radius
  const geometry = new THREE.CapsuleGeometry(radius, height)
  geometry.translate(0, fullHeight / 2, 0)
  return geometry
}

// the playback options in an emote url's query (?s=1.5&l=0&g=1), remembered per url up to a bound. Keyed by the
// url as given. It used to be an object keyed by the parsed URL (which a property name turns back into its
// string: a hit for a url already in canonical form, a miss for any other spelling), and it grew with every url a
// remote player sent. A url that does not parse has no options.
const QUERY_PARAMS_LIMIT = 256
const queryParams = new Map()
function getQueryParams(url) {
  let params = queryParams.get(url)
  if (!params) {
    params = {}
    try {
      for (const [key, value] of new URL(url).searchParams.entries()) {
        if (key === 's' || key === 'l' || key === 'g') params[key] = value
      }
    } catch {
      // no options
    }
    if (queryParams.size >= QUERY_PARAMS_LIMIT) queryParams.clear()
    queryParams.set(url, params)
  }
  return params
}
