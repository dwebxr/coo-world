// Small client-side defects (P13): a teleport that came before the player's body existed was lost, every control's
// action for the same key was listed, an XR input source with fewer buttons than a controller ended the script's
// control, and the agent's token file and log.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { loadClient } from './lib/clientHarness.mjs'
import { readXRGamepad } from '../src/core/extras/xrGamepad.js'
import { callEntry, callScript } from '../src/core/extras/callScript.js'
import { briefError, createLogOnce } from '../src/core/extras/logOnce.js'
import * as physxConvert from '../src/core/extras/physxConvert.js'
import { agentId, logText, saveTokenFile, tokenFileOf } from '../scripts/lib/agentFiles.mjs'

const physics = {
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

const Player = loadClient('core/entities/PlayerLocal.js', 'PlayerLocal', { ...physxConvert, PHYSX: physics })

function player({ body = false } = {}) {
  const sent = []
  const snaps = []
  const p = Object.assign(Object.create(Player.prototype), {
    data: { id: 'me' },
    base: new THREE.Object3D(),
    cam: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), rotation: new THREE.Euler(), zoom: 1 },
    camHeight: 1.6,
    world: { network: { send: (name, data) => sent.push([name, data]) } },
  })
  if (body) {
    // as after init(): the body, then the control with its camera
    const pose = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }
    p.capsule = { getGlobalPose: () => pose }
    p.capsuleHandle = { snap: pose => snaps.push({ ...pose.p }) }
    p.control = { camera: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() } }
  }
  return { p, sent, snaps }
}

test('PlayerLocal.teleport: one that comes before the body exists is taken, and the body is made there', () => {
  // the server sends a teleport as soon as the player has joined (a spawn point), while init() still waits for
  // the first assets: reading the pose of a body that was not there threw, and the teleport was lost
  const early = player()
  assert.equal(early.p.capsule, undefined)
  early.p.teleport({ position: [3, 4, 5], rotationY: 1 })
  assert.deepEqual(early.p.base.position.toArray(), [3, 4, 5])
  // which is where the body is made, and what the control's camera is set from, once init() gets there
  const source = fs.readFileSync(new URL('../src/core/entities/PlayerLocal.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /initCapsule\(\) \{[^]*?vec3ToPxPos\(v1\.copy\(this\.base\.position\), transform\)[^]*?this\.capsule = /
  )
  assert.match(source, /initControl\(\) \{[^]*?this\.control\.camera\.position\.copy\(this\.cam\.position\)/)
  assert.equal(early.p.base.rotation.y, 1)
  assert.equal(early.sent.length, 1)
  assert.deepEqual(early.sent[0][1].p, [3, 4, 5])
  assert.equal(early.sent[0][1].t, true)
  assert.deepEqual(early.p.cam.position.toArray(), [3, 4 + 1.6, 5])
  // with a body, it is moved as before
  const later = player({ body: true })
  later.p.teleport({ position: [7, 8, 9] })
  assert.deepEqual(later.snaps, [{ x: 7, y: 8, z: 9 }])
  assert.deepEqual(later.p.base.position.toArray(), [7, 8, 9])
  assert.equal(later.sent.length, 1)
  assert.deepEqual(later.p.control.camera.position.toArray(), [7, 8 + 1.6, 9], 'and the camera with it')
  // a position that is not one is refused either way
  for (const { p, sent } of [player(), player({ body: true })]) {
    p.teleport({ position: [NaN, 0, 0] })
    assert.deepEqual(p.base.position.toArray(), [0, 0, 0])
    assert.equal(sent.length, 0)
  }
})

const Controls = loadClient('core/systems/ClientControls.js', 'ClientControls', {
  readXRGamepad,
  callEntry,
  callScript,
  briefError,
  createLogOnce,
})

test('ClientControls.buildActions: every action of every active control is listed, also two for one key', () => {
  const emitted = []
  const controls = Object.assign(Object.create(Controls.prototype), {
    world: { emit: (name, value) => emitted.push([name, value]) },
    controls: [
      {
        active: true,
        actions: [
          { type: 'space', label: 'Jump / Fly' },
          { type: 'custom', label: 'Wave' },
        ],
      },
      { active: false, actions: [{ type: 'keyF', label: 'Hidden' }] },
      { active: true, actions: null },
      // a control lower down that captures the key: its hint is the one that is true, and it must not be dropped
      // for the one above (a check that listed the first per key was written here and never ran)
      {
        active: true,
        actions: [
          { type: 'space', label: 'Fire' },
          { type: 'custom', label: 'Dance' },
          { type: 'keyQ', label: 'Drop' },
          { type: 'keyQ', label: 'Drop all' },
        ],
      },
    ],
  })
  controls.buildActions()
  assert.deepEqual(
    controls.actions.map(action => action.label),
    ['Jump / Fly', 'Wave', 'Fire', 'Dance', 'Drop', 'Drop all']
  )
  assert.deepEqual(emitted, [['actions', controls.actions]])
})

// the frame's XR input as the controls system reads it, for one hand
function xrFrame(gamepad, entries) {
  const failures = []
  const control = {
    active: true,
    entries,
    options: { object: { isApp: true, data: { id: 'app' }, crash: () => failures.push('crashed') } },
  }
  const controls = Object.assign(Object.create(Controls.prototype), {
    controls: [control],
    scroll: { delta: 0 },
    xrSession: { inputSources: [{ gamepad, handedness: 'left' }] },
    world: { graphics: { renderer: { xr: { getReferenceSpace: () => ({}), getFrame: () => ({}) } } }, entities: {} },
  })
  controls.preFixedUpdate()
  return failures
}
const xrEntries = () => ({
  xrLeftStick: { value: { x: 9, z: 9 } },
  xrLeftTrigger: { down: false, value: 9 },
  xrLeftGrip: { down: false, value: 9 },
  xrLeftBtn1: { down: true },
  xrLeftBtn2: { down: false },
})

test('ClientControls: an XR input source with fewer buttons than a controller does not end a script’s control', () => {
  const button = (value, pressed = value > 0) => ({ value, pressed })
  // a hand: a gamepad with nothing on it. Reading buttons[4].pressed threw on every frame, and the app crashed
  const hand = xrEntries()
  assert.deepEqual(xrFrame({ buttons: [], axes: [] }, hand), [])
  assert.deepEqual(hand.xrLeftStick.value, { x: 0, z: 0 })
  assert.deepEqual([hand.xrLeftTrigger.down, hand.xrLeftTrigger.value], [false, 0])
  assert.deepEqual([hand.xrLeftGrip.down, hand.xrLeftGrip.value], [false, 0])
  assert.equal(hand.xrLeftBtn1.down, false)
  assert.equal(hand.xrLeftBtn1.released, true, 'a button that was down is let go')
  assert.equal(hand.xrLeftBtn2.down, false)
  // a full controller is read as before
  const full = xrEntries()
  const failures = xrFrame(
    { buttons: [button(0.95), button(0.5), button(0), button(0), button(1), button(1)], axes: [0, 0, 0.25, -0.75] },
    full
  )
  assert.deepEqual(failures, [])
  assert.deepEqual(full.xrLeftStick.value, { x: 0.25, z: -0.75 })
  assert.deepEqual([full.xrLeftTrigger.down, full.xrLeftTrigger.value], [true, 0.95])
  assert.deepEqual([full.xrLeftGrip.down, full.xrLeftGrip.value], [true, 0.5])
  assert.deepEqual([full.xrLeftBtn1.down, full.xrLeftBtn2.down], [true, true])
  assert.equal(full.xrLeftBtn2.pressed, true)
})

test('readXRGamepad: what an input source lacks reads as not pressed', () => {
  const button = (value, pressed = value > 0) => ({ value, pressed, touched: pressed })
  // a full controller (xr-standard: trigger, grip, touchpad, thumbstick, two face buttons; four axes)
  assert.deepEqual(
    readXRGamepad({
      buttons: [button(0.95), button(0.5), button(0), button(0), button(1), button(0)],
      axes: [0, 0, 0.25, -0.75],
    }),
    { stickX: 0.25, stickZ: -0.75, trigger: 0.95, grip: 0.5, gripDown: true, button1Down: true, button2Down: false }
  )
  const nothing = {
    stickX: 0,
    stickZ: 0,
    trigger: 0,
    grip: 0,
    gripDown: false,
    button1Down: false,
    button2Down: false,
  }
  // a hand, a controller with a trigger only, no gamepad at all: reading buttons[4].pressed of these threw
  assert.deepEqual(readXRGamepad({ buttons: [], axes: [] }), nothing)
  assert.deepEqual(readXRGamepad({ buttons: [button(1)], axes: [0.5, 0.5] }), { ...nothing, trigger: 1 })
  for (const gamepad of [null, undefined, {}, { buttons: null, axes: null }]) {
    assert.deepEqual(readXRGamepad(gamepad), nothing)
  }
  // values that are not numbers, and "pressed" that is not a boolean, are nothing
  assert.deepEqual(
    readXRGamepad({
      buttons: [{ value: NaN }, { value: '1', pressed: 1 }, null, undefined, { pressed: 'yes' }, { pressed: {} }],
      axes: [0, 0, Infinity, undefined],
    }),
    nothing
  )
})

test('agent: its id is part of a file name and nothing else', () => {
  assert.equal(agentId(undefined), 'default')
  assert.equal(agentId(''), 'default')
  // ids people run with keep working, and keep their token file
  for (const id of ['a', 'bot-7', 'Agent_01', 'bot.prod', 'x'.repeat(64)]) assert.equal(agentId(id), id)
  assert.equal(tokenFileOf('/srv/agent', 'bot.prod'), path.join('/srv/agent', '.agent-token-bot.prod.json'))
  // it went into the path as it was: a separator in it left the directory
  assert.notEqual(path.dirname(path.join('/srv/agent', '.agent-token-../../../x.json')), '/srv/agent')
  for (const id of ['../../../x', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 'é', 'a\0b', 7, null, {}]) {
    assert.equal(agentId(id), null, JSON.stringify(id))
  }
  // a name of dots only stays in the directory, behind the prefix
  for (const id of ['.', '..']) {
    assert.equal(path.dirname(tokenFileOf('/srv/agent', agentId(id))), '/srv/agent')
  }
})

test('agent: the token is never in a file others can read, also when the token file was there with another mode', t => {
  if (process.platform === 'win32') return t.skip('no such file modes')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-token-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = tokenFileOf(dir, 'bot')
  saveTokenFile(file, 'first')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { authToken: 'first' })
  // a file an earlier version wrote, readable by everyone: the new token is not written into it. What is written
  // is a new file, private from the start, and every state of it on the way is checked
  fs.chmodSync(file, 0o644)
  const seen = []
  const watched = {
    writeFileSync(target, data, options) {
      fs.writeFileSync(target, data, options)
      seen.push(['write', path.basename(target), fs.statSync(target).mode & 0o777, options.flag])
    },
    renameSync(from, to) {
      seen.push(['old file still holds', JSON.parse(fs.readFileSync(to, 'utf8')).authToken])
      fs.renameSync(from, to)
    },
    rmSync: fs.rmSync,
  }
  saveTokenFile(file, 'second', { fs: watched, suffix: 'x' })
  assert.deepEqual(seen, [
    ['write', '.agent-token-bot.json.x.tmp', 0o600, 'wx'],
    ['old file still holds', 'first'],
  ])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { authToken: 'second' })
  assert.deepEqual(fs.readdirSync(dir), ['.agent-token-bot.json'], 'nothing is left beside it')
  // a link planted at the token's place is replaced, not followed
  const elsewhere = path.join(dir, 'elsewhere.txt')
  fs.writeFileSync(elsewhere, 'untouched')
  fs.rmSync(file)
  fs.symlinkSync(elsewhere, file)
  saveTokenFile(file, 'third')
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'untouched')
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { authToken: 'third' })
  // a rename that fails leaves no half-written file, and says so
  const failing = { ...watched, renameSync: () => { throw new Error('rename refused') } } // prettier-ignore
  assert.throws(() => saveTokenFile(file, 'fourth', { fs: failing, suffix: 'y' }), /rename refused/)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.agent-token-bot.json', 'elsewhere.txt'])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { authToken: 'third' })
})

test('agent.mjs: the id, the token file, the log and a failed start go through these', () => {
  const source = fs.readFileSync(new URL('../agent.mjs', import.meta.url), 'utf8')
  assert.match(
    source,
    /^const AGENT_ID = agentId\(process\.env\.AGENT_ID\)\nif \(AGENT_ID === null\) \{[^}]*process\.exit\(1\)\n\}/m
  )
  assert.match(source, /^const tokenFile = tokenFileOf\(dirname, AGENT_ID\)$/m)
  assert.match(source, /saveTokenFile\(tokenFile, token\)/)
  assert.doesNotMatch(source, /writeFileSync/)
  // nothing of another player's goes to the log as it came
  assert.match(source, /console\.log\(`\[chat\] \$\{logText\(last\.from, 80\)\}: \$\{logText\(last\.body\)\}`\)/)
  assert.doesNotMatch(source, /\$\{last\.(from|body)\}/)
  // a start that fails ends in the same retry a lost connection does, once per world
  assert.match(
    source,
    /\.then\(\(\) =>\n\s+world\.init\(\{[^]*?\}\)\n\s+\)\n\s+\.catch\(err => \{\n[^\n]*\n\s+retry\(world\)\n\s+\}\)/
  )
  assert.match(source, /world\.on\('disconnect', \(\) => retry\(world\)\)/)
  assert.match(source, /^function retry\(world\) \{\n {2}if \(currentWorld !== world\) return\n/m)
})

test('agent: another player’s text reaches the terminal without its control characters, and cut', () => {
  const escape = String.fromCharCode(27)
  assert.equal(logText(`hi ${escape}[2J${escape}[31mred`), 'hi ?[2J?[31mred')
  assert.equal(logText('one\ntwo\rthree\tfour'), 'one?two?three?four')
  const controls = [0, 7, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]
  for (const code of controls) assert.equal(logText(`a${String.fromCharCode(code)}b`), 'a?b', code.toString(16))
  // ordinary text of any script is left as it is
  for (const text of ['hello', 'こんにちは', 'héllo wörld', '👋 hi', 'a b', '']) assert.equal(logText(text), text)
  assert.equal(logText('x'.repeat(600)), `${'x'.repeat(500)}…`)
  assert.equal(logText('abcdef', 3), 'abc…')
  assert.equal(logText(undefined), 'undefined')
  assert.equal(logText({ toString: () => { throw new Error('no') } }), '?') // prettier-ignore
})
