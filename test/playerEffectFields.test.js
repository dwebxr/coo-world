import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { loadClient } from './lib/clientHarness.mjs'
import { Modes } from '../src/core/extras/locomotionModes.js'
import { isEmoteUrl } from '../src/core/extras/entityModifyPolicy.js'
import * as physxConvert from '../src/core/extras/physxConvert.js'

const validateEmote = mock.fn(isEmoteUrl)

const physics = {
  PxForceModeEnum: { eFORCE: 1 },
  PxVec3: class {
    constructor() {
      this.x = 0
      this.y = 0
      this.z = 0
    }
  },
}
const previousPhysX = Object.getOwnPropertyDescriptor(globalThis, 'PHYSX')
before(() => {
  globalThis.PHYSX = physics
})
after(() => {
  if (previousPhysX) Object.defineProperty(globalThis, 'PHYSX', previousPhysX)
  else delete globalThis.PHYSX
})

const Player = loadClient('core/entities/PlayerLocal.js', 'PlayerLocal', {
  ...physxConvert,
  Modes,
  clamp: THREE.MathUtils.clamp,
  Layers: { environment: { group: 1 }, prop: { group: 2 } },
  PHYSX: physics,
  isEmoteUrl: validateEmote,
})

function makePlayer(effect) {
  const button = { down: false, pressed: false }
  const player = Object.assign(Object.create(Player.prototype), {
    data: { effect },
    isXR: false,
    firstPerson: false,
    base: new THREE.Object3D(),
    cam: new THREE.Object3D(),
    moveDir: new THREE.Vector3(),
    flyDir: new THREE.Vector3(),
    axis: new THREE.Vector3(),
    gaze: new THREE.Vector3(),
    world: { networkRate: Infinity },
    lastSendAt: 0,
    control: {
      pointer: { locked: false },
      scrollDelta: { value: 0 },
      space: button,
      touchA: button,
      keyW: button,
      keyS: button,
      keyA: button,
      keyD: button,
      arrowUp: button,
      arrowDown: button,
      arrowLeft: button,
      arrowRight: button,
      shiftLeft: button,
      shiftRight: button,
    },
    getAnchorMatrix: () => null,
    setEffect(value) {
      this.data.effect = value
    },
    avatar: {
      setEmote(value) {
        this.emote = value
      },
      instance: {
        setLocomotion(value) {
          this.mode = value
        },
      },
    },
  })
  player.cam.zoom = 2
  return player
}

test('PlayerLocal: invalid emotes are ignored by playback and locomotion; valid emotes override both', () => {
  for (const emote of [{}, [], 1, true, null, undefined, '', 'javascript:alert(1)', 'asset://bad.txt']) {
    const player = makePlayer({ emote })
    player.control.keyW = { down: true }
    player.emote = 'asset://previous.glb'
    player.update(0.1)
    assert.equal(player.emote, undefined)
    assert.equal(player.avatar.emote, undefined)
    assert.equal(player.avatar.instance.mode, Modes.WALK)
  }
  for (const emote of ['asset://wave.glb?s=2', 'https://example.com/wave.glb']) {
    const player = makePlayer({ emote })
    player.control.keyW = { down: true }
    player.update(0.1)
    assert.equal(player.avatar.emote, emote)
    assert.equal(player.avatar.instance.mode, Modes.IDLE)
  }
})

test('PlayerLocal: turn requires boolean true', () => {
  for (const turn of [false, 'true', 1, {}, [], null, undefined]) {
    const player = makePlayer({ turn })
    player.cam.rotation.y = Math.PI / 2
    player.update(0.1)
    assert.equal(player.base.quaternion.angleTo(new THREE.Quaternion()), 0)
  }
  const player = makePlayer({ turn: true })
  player.cam.rotation.y = Math.PI / 2
  player.update(0.1)
  assert.ok(player.base.quaternion.angleTo(new THREE.Quaternion()) > 0)
})

test('PlayerLocal: emote validation is cached until the raw value changes', () => {
  validateEmote.mock.resetCalls()
  const player = makePlayer({ emote: 'https://example.com/wave.glb' })
  player.control.keyW = { down: true }
  for (const [emote, valid, calls] of [
    ['https://example.com/wave.glb', true, 1],
    ['https://example.com/dance.glb', true, 2],
    ['javascript:alert(1)', false, 3],
    ['asset://bad.txt', false, 4],
    ['https://example.com/wave.glb', true, 5],
    [undefined, false, 5],
    ['https://example.com/wave.glb', true, 6],
  ]) {
    player.data.effect.emote = emote
    for (let frame = 0; frame < 4; frame++) {
      player.update(0.1)
      assert.equal(validateEmote.mock.callCount(), calls)
      assert.equal(player.avatar.emote, valid ? emote : undefined)
      assert.equal(player.avatar.instance.mode, valid ? Modes.IDLE : Modes.WALK)
    }
  }
})

test('PlayerLocal: falsy duration has no expiry; truthy duration counts down numerically or ends the effect', () => {
  for (const duration of [0, '', null, undefined, NaN, false, Infinity]) {
    const effect = { duration }
    const player = makePlayer(effect)
    for (let frame = 0; frame < 4; frame++) {
      player.update(0.1)
      assert.equal(player.data.effect, effect)
      assert.equal(player.data.effect.duration, duration)
    }
  }
  for (const duration of [-1, -Infinity, 'not a number', {}, [], '0', ' ', '-1']) {
    const player = makePlayer({ duration })
    player.update(0.1)
    assert.equal(player.data.effect, null)
  }
  const player = makePlayer({ duration: 0.2 })
  player.update(0.1)
  assert.equal(player.data.effect.duration, 0.1)
  player.update(0.1)
  assert.equal(player.data.effect, null)
  const numericString = makePlayer({ duration: '2' })
  numericString.update(0.5)
  assert.equal(numericString.data.effect.duration, 1.5)
  numericString.update(1)
  assert.equal(numericString.data.effect.duration, 0.5)
  numericString.update(0.5)
  assert.equal(numericString.data.effect, null)
})

test('PlayerLocal: typed snare controls finite movement forces and jump inhibition', () => {
  for (const snare of [NaN, Infinity, -Infinity, -1, 2, '0.5', {}, null, undefined, 0, 0.5, 1]) {
    const player = makePlayer({ snare })
    const forces = []
    let velocity = { x: 0, y: 0, z: 0 }
    Object.assign(player, {
      moving: true,
      jumpDown: true,
      mass: 1,
      effectiveGravity: 9.81,
      jumpHeight: 1,
      groundNormal: new THREE.Vector3(0, 1, 0),
      groundSweepRadius: 0.3,
      platform: {},
      materialMax: true,
      capsule: {
        getGlobalPose: () => ({ p: { x: 0, y: 0, z: 0 } }),
        getLinearVelocity: () => ({ ...velocity }),
        setLinearVelocity: value => {
          velocity = { ...value }
        },
        addForce: value => forces.push({ ...value }),
      },
    })
    player.moveDir.set(1, 0, 0)
    player.world.physics = { sweep: () => ({ normal: new THREE.Vector3(0, 1, 0) }) }
    player.fixedUpdate(0.1)
    const accepted = Number.isFinite(snare) && snare >= 0 && snare <= 1 ? snare : 0
    assert.equal(forces.length, 1)
    assert.equal(forces[0].x, 30 * (1 - accepted))
    assert.ok(Object.values(forces[0]).every(Number.isFinite))
    assert.equal(velocity.y > 0, !accepted)
  }
})

// Run both actual animation consumers with a loader/mixer adapter, as the network harness does for handlers.
const source = fs.readFileSync(new URL('../src/core/extras/createVRMFactory.js', import.meta.url), 'utf8')
const setEmoteSource = source.slice(source.indexOf('    const setEmote = url => {'), source.indexOf('    // IDEA:'))
const addPoseSource = source.slice(
  source.indexOf('    function addPose(key, url) {'),
  source.indexOf("    addPose('idle'")
)
const querySource = source.slice(source.indexOf('let queryParams = {}'))
const makeConsumers = new Function(
  'THREE',
  'hooks',
  'mixer',
  `
  const emotes = {}
  let currentEmote
  const poses = {}
  const rootToHips = 1
  const version = '1'
  const getBoneName = () => 'hips'
  const clearLocomotion = () => {}
  ${setEmoteSource}
  ${addPoseSource}
  ${querySource}
  return { setEmote, addPose, emotes, poses }
`
)

test('VRM emote and locomotion parsers: finite speed in [0.01, 100], otherwise 1; l/g stay string flags', async () => {
  for (const [speed, expected] of [
    [undefined, 1],
    ['', 1],
    ['NaN', 1],
    ['Infinity', 1],
    ['1e309', 1],
    ['-Infinity', 1],
    ['0', 1],
    ['-1', 1],
    ['0.009', 1],
    ['100.001', 1],
    ['0.01', 0.01],
    ['100', 100],
    ['2.5', 2.5],
  ]) {
    for (const [flags, loop, gaze] of [
      ['', true, false],
      ['&l=0&g=1', false, true],
      ['&l=false&g=true', true, false],
    ]) {
      const actions = []
      const consumers = makeConsumers(
        THREE,
        { loader: { load: async () => ({ toClip() {} }) } },
        {
          clipAction: () => {
            const action = {
              setLoop(value) {
                this.loop = value
              },
              play() {},
            }
            actions.push(action)
            return action
          },
        }
      )
      const url = `asset://wave.glb?${speed === undefined ? '' : `s=${speed}`}${flags}`
      consumers.setEmote(url)
      consumers.addPose('probe', url)
      await Promise.resolve()
      assert.equal(actions.length, 2)
      assert.equal(actions[0].timeScale, expected)
      assert.equal(actions[1].timeScale, expected)
      assert.equal(actions[0].loop, loop ? THREE.LoopRepeat : THREE.LoopOnce)
      assert.equal(actions[0].clampWhenFinished, !loop)
      assert.equal(consumers.emotes[url].gaze, gaze)
    }
  }
})
