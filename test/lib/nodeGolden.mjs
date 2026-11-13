// The golden characterization of the node classes (P17-0): what each node type's script handle (its proxy) and its
// class do with a fixed list of values, written out as text, one file per node type (test/golden/nodes/<type>.txt),
// so that a change to src/core/nodes shows as a diff of those files. test/nodeGolden.test.js compares and rewrites
// them; the legend of the rows, and what this cannot see, is written at the top of that file.
//
// Everything here runs in the test's own process on a bundle of the node classes (as teardownNodeTypes.test.js does):
// each node type gets a fresh evaluation of the bundle (its once-only warnings start unsaid), the cases run in a fixed
// order, and nothing printed carries an address, a time or a path. A node's automatic id is printed as `<auto>`.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { types as utilTypes } from 'node:util'
import * as esbuild from 'esbuild'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// `node` first (the other types' Node keys are compared with it), then the exports of src/core/nodes/index.js in the
// order of the module namespace (by name)
export const NODE_TYPES = [
  'node',
  'action',
  'anchor',
  'audio',
  'avatar',
  'collider',
  'controller',
  'group',
  'image',
  'joint',
  'lod',
  'mesh',
  'nametag',
  'particles',
  'prim',
  'rigidbody',
  'skinnedmesh',
  'sky',
  'snap',
  'ui',
  'uiimage',
  'uitext',
  'uiview',
  'video',
]

// the test files that compare the golden files, and the node types each generates (each file runs in its own process,
// so they run side by side; each also generates the node type, which the others refer to)
export const SHARDS = {
  'nodeGolden.test.js': [
    'node',
    'action',
    'anchor',
    'avatar',
    'group',
    'image',
    'lod',
    'nametag',
    'skinnedmesh',
    'snap',
  ],
  'nodeGoldenPhysics.test.js': ['collider', 'controller', 'joint', 'rigidbody'],
  'nodeGoldenScene.test.js': ['mesh', 'prim', 'sky'],
  'nodeGoldenEffects.test.js': ['audio', 'particles'],
  'nodeGoldenUi.test.js': ['ui', 'uiimage', 'uitext'],
  'nodeGoldenView.test.js': ['uiview', 'video'],
}

export const GOLDEN_DIR = fileURLToPath(new URL('../golden/nodes/', import.meta.url))

const root = fileURLToPath(new URL('../../', import.meta.url))

// The packages the node classes import are left out of the bundle and imported from node_modules, so every
// evaluation of the bundle shares one of each (three.js is 2.5 MB of the 3.4 MB the bundle would be, compiled again
// for each node type); src/ is bundled, and so evaluated afresh for each type.
const SHARED = /^(three|three-mesh-bvh|yoga-layout|lodash-es)(\/.*)?$/

export async function bundleNodes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-golden-'))
  const outfile = path.join(dir, 'nodes.mjs')
  await esbuild.build({
    stdin: {
      contents: `
        export * as Nodes from './src/core/nodes'
        export { Node } from './src/core/nodes/Node'
        export * as THREE from './src/core/extras/three'
        export { getNodeRef, resolveValueRef } from './src/core/nodes/refs'
        export { isScriptView } from './src/core/extras/sealMath.js'
        export { glbToNodes } from './src/core/extras/glbToNodes'
      `,
      resolveDir: root,
      sourcefile: 'golden-entry.js',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['*physx-js-webidl.js'],
    define: { 'process.env.CLIENT': 'false', 'process.env.SERVER': 'true' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'shared-packages',
        setup(build) {
          build.onResolve({ filter: SHARED }, args => ({
            path: fileURLToPath(import.meta.resolve(args.path)),
            external: true,
          }))
        },
      },
    ],
  })
  return {
    url: pathToFileURL(outfile).href,
    destroy: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the values

// the hostile list (row c): the same labels for every settable key, in this order
const HOSTILE = [
  ['undefined', () => undefined],
  ['null', () => null],
  ['NaN', () => NaN],
  ['Infinity', () => Infinity],
  ['-Infinity', () => -Infinity],
  ['-1', () => -1],
  ['-0', () => -0],
  ['0', () => 0],
  ['0.5', () => 0.5],
  ['1', () => 1],
  ['1e9', () => 1e9],
  ["''", () => ''],
  ["'x'", () => 'x'],
  ['true', () => true],
  ['false', () => false],
  ['{}', () => ({})],
  ['[]', () => []],
  ['[1,2,3]', () => [1, 2, 3]],
  ['[NaN]', () => [NaN]],
  ['Number(1)', () => new Number(1)], // eslint-disable-line no-new-wrappers
  ["String('x')", () => new String('x')], // eslint-disable-line no-new-wrappers
  ['Boolean(true)', () => new Boolean(true)], // eslint-disable-line no-new-wrappers
  ['Proxy[1,2,3]', fx => fx.trapArray()],
  ['fn', () => function hostileFn() {}],
  ['Symbol', () => Symbol('s')],
  ['1n', () => 1n],
  [
    '{toString throws}',
    () => ({
      toString() {
        throw new Error('toString called')
      },
    }),
  ],
]

const PIVOTS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]
const LAYERS = ['environment', 'prop', 'player', 'tool']
const FLEX = {
  flexDirection: ['column', 'column-reverse', 'row', 'row-reverse'],
  justifyContent: ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  alignItems: ['stretch', 'flex-start', 'flex-end', 'center', 'baseline'],
  alignContent: ['flex-start', 'flex-end', 'stretch', 'center', 'space-between', 'space-around', 'space-evenly'],
  flexWrap: ['no-wrap', 'wrap', 'wrap-reverse'],
  display: ['flex', 'none'],
}

const strs = (...values) => values.map(value => () => value)
const long = length => () => 'w'.repeat(length)
const v3 = (x, y, z) => fx => new fx.THREE.Vector3(x, y, z)
const geometry = fx => fx.geometryA
const geometryRef = fx => fx.geometryRef()
const edges = () => [() => [1, 2, 3, 4], () => [1, 2, 3], () => [1, 'x', 3, 4]]

// the values a property accepts, where the hostile list has none (an enum, a vector, an array of a shape, a fixture),
// and a few more of its edges (a text one past its bound); appended to the hostile list (a label already there is
// not repeated)
const NODE_VALID = {
  id: strs('id-a'),
  position: [v3(1, 2, 3)],
  quaternion: [fx => new fx.THREE.Quaternion(0, 1, 0, 0)],
  rotation: [fx => new fx.THREE.Euler(0, 1, 0, 'YXZ')],
  scale: [v3(2, 2, 2)],
  parent: [fx => fx.otherNode],
  cursor: [...strs('pointer', 'url(hand.png), grab'), long(129)],
}
const UI_CHILD = {
  display: strs(...FLEX.display),
  top: strs(5),
  right: strs(5),
  bottom: strs(5),
  left: strs(5),
  backgroundColor: strs('red'),
  margin: edges(),
  padding: edges(),
  flexBasis: strs('auto', 10),
}
const AUDIO = {
  group: strs('music', 'sfx'),
  distanceModel: strs('linear', 'inverse', 'exponential'),
}
const VALID = {
  node: {},
  action: { label: [...strs('Use'), long(257)] },
  anchor: {},
  audio: { src: strs('asset://a.mp3'), ...AUDIO, currentTime: strs(3) },
  avatar: { src: strs('asset://a.vrm'), emote: strs('asset://e.glb') },
  collider: {
    type: strs('box', 'sphere', 'geometry'),
    geometry: [geometry, geometryRef],
    layer: strs(...LAYERS, 'bogus'),
  },
  controller: { layer: strs(...LAYERS, 'bogus'), tag: strs('t') },
  group: {},
  image: {
    src: strs('asset://a.png'),
    fit: strs('none', 'cover', 'contain'),
    pivot: strs(...PIVOTS),
    color: strs('red'),
  },
  joint: {
    type: strs('fixed', 'socket', 'hinge', 'distance', 'bogus'),
    body0: [fx => fx.rigidbodyProxy(), fx => fx.meshProxy(), fx => fx.rigidbodyNode()],
    body1: [fx => fx.rigidbodyProxy(), fx => fx.meshProxy(), fx => fx.rigidbodyNode()],
  },
  lod: {},
  mesh: {
    type: strs('box', 'sphere', 'geometry'),
    geometry: [geometry, geometryRef],
    material: [fx => fx.materialA],
  },
  nametag: { label: [...strs('Hi'), long(257)] },
  particles: {
    shape: [() => ['sphere', 2, 0.5], () => ['point'], () => ['bogus'], () => ['box', {}]],
    bursts: [
      () => [{ time: 1, count: 5 }],
      () => [{ time: '1', count: 5 }],
      () => [{ time: 2e6, count: 1e9 }],
      () => Array.from({ length: 65 }, (_, i) => ({ time: i, count: 1 })),
    ],
    life: [...strs('1~3'), long(257)],
    speed: strs('1-3'),
    color: strs('red'),
    image: strs('asset://p.png'),
    spritesheet: [() => [2, 2, 10, 10], () => [2, 2, 10], () => [2, {}, 10, 10]],
    blending: strs('additive', 'normal'),
    billboard: strs('full', 'y', 'direction'),
    space: strs('local', 'world'),
    force: [v3(1, 2, 3)],
    velocityLinear: [v3(1, 2, 3)],
    velocityOrbital: [v3(1, 2, 3)],
    sizeOverLife: [...strs('0,1|1,0'), long(4097)],
  },
  prim: {
    type: strs('box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'bogus'),
    size: [
      () => [1, 2, 3],
      () => [0.5],
      () => [1, 2],
      () => new Array(17).fill(1),
      () => [1, '2', 3],
      () => new Array(3),
    ],
    color: strs('red'),
    emissive: strs('red'),
    texture: strs('asset://t.png'),
    physics: strs('static', 'kinematic', 'dynamic', 'bogus'),
    mass: strs(1e-9, 1e-10, 2),
    layer: strs(...LAYERS, 'bogus'),
    tag: strs('t'),
  },
  rigidbody: {
    type: strs('static', 'kinematic', 'dynamic', 'bogus'),
    mass: strs(2, 1e-9, 1e-10),
    tag: strs('t'),
  },
  skinnedmesh: {},
  sky: {
    bg: strs('asset://bg.png'),
    hdr: strs('asset://h.hdr'),
    rotationY: strs(2e9),
    sunDirection: [v3(0, -1, 0), v3(NaN, 0, 0), () => ({ isVector3: true, x: 1, y: 2, z: 3 })],
    sunColor: strs('red'),
    fogColor: strs('red'),
  },
  snap: {},
  ui: {
    space: strs('world', 'screen'),
    billboard: strs('none', 'full', 'y'),
    pivot: strs(...PIVOTS),
    offset: [v3(1, 2, 3), v3(4, 5, 6)],
    scaler: [() => [1, 10], () => [1, 10, 2], () => [1, 'x'], () => [1, 10, {}]],
    backgroundColor: strs('red'),
    borderColor: strs('red'),
    padding: edges(),
    ...Object.fromEntries(Object.entries(FLEX).map(([key, list]) => [key, strs(...list)])),
  },
  uiimage: { ...UI_CHILD, src: strs('asset://a.png'), objectFit: strs('contain', 'cover', 'fill') },
  uitext: {
    ...UI_CHILD,
    value: [...strs('Hello'), long(10001)],
    color: strs('red'),
    textAlign: strs('left', 'center', 'right'),
    fontFamily: strs('Rubik'),
    fontWeight: strs('bold', 700),
  },
  uiview: {
    ...UI_CHILD,
    borderColor: strs('red'),
    ...Object.fromEntries(Object.entries(FLEX).map(([key, list]) => [key, strs(...list)])),
  },
  video: {
    screenId: strs('screen-1'),
    src: strs('asset://v.mp4'),
    linked: strs('tag'),
    color: strs('red'),
    fit: strs('none', 'cover', 'contain'),
    pivot: strs(...PIVOTS),
    geometry: [geometry, geometryRef],
    ...AUDIO,
    time: strs(3),
    currentTime: strs(3),
  },
}
// a property kept in a field of another name (its own field for `$in`)
const OWN_FIELDS = { audio: { currentTime: 'offset' } }
// the keys that take a value only on a node whose parts are there (row h pairs them with a stateful stand-in each)
const MOUNTED_PAIRS = {
  audio: { currentTime: node => (node.ctx = { world: { audio: { ctx: { currentTime: 10 } } } }) },
  video: {
    time: node => (node.instance = { currentTime: 0 }),
    currentTime: node => (node.instance = { currentTime: 0 }),
  },
}
// getters that read another key by design (row i reads each with the other redefined on the proxy)
const ALIASES = {
  video: [
    ['isPlaying', 'playing'],
    ['currentTime', 'time'],
  ],
}
// getters that read the same in every state (row i does not compare them with the others)
const CONSTANT_GETTERS = ['name', '_ref', '_isRef', 'transparent']
const HOST_CTOR_KEYS = {
  skinnedmesh: { object3d: '_object3d', animations: '_animations' },
  avatar: { factory: 'factory', hooks: 'hooks' },
}

// ---------------------------------------------------------------------------------------------------------------------
// the stand-ins that make a node look mounted (row e): each records what the setter did to it

// a stub records its property writes and calls (`name.key=value`, `name.key(args)`); a read of an unknown key gives a
// stub of that name, a read of a key in `fields` gives that value
function makeStubs(record, describe) {
  const names = new WeakMap()
  function stub(name, fields = {}) {
    const children = new Map()
    const target = function () {}
    const proxy = new Proxy(target, {
      get(_, key) {
        if (typeof key === 'symbol') return undefined
        if (Object.hasOwn(fields, key)) return fields[key]
        if (!children.has(key)) children.set(key, stub(`${name}.${key}`))
        return children.get(key)
      },
      set(_, key, value) {
        record(`${name}.${String(key)}=${describe(value)}`)
        return true
      },
      apply(_, thisArg, args) {
        record(`${name}(${args.map(describe).join(',')})`)
        return undefined
      },
      has: () => false,
      ownKeys: () => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (_, key) => Reflect.getOwnPropertyDescriptor(target, key),
    })
    names.set(proxy, name)
    return proxy
  }
  return { stub, nameOf: value => names.get(value) }
}

// the keys whose setters multiply by the UI's res (a second res is tried for them)
const RES_KEYS = {
  ui: ['width', 'height', 'padding', 'gap'],
  uiview: ['width', 'height', 'top', 'right', 'bottom', 'left', 'margin', 'padding', 'gap'],
  uitext: ['top', 'right', 'bottom', 'left', 'margin', 'padding'],
  uiimage: ['top', 'right', 'bottom', 'left', 'margin'],
}

// per node type: the states in which a setter takes another branch, by reading the setters (`this.handle &&`,
// `this.shape ||`, `this.yogaNode?.`, `this.ui?.`, `this.source`, ...). `keys` limits a state to some properties.
function scenarios(type) {
  const ui = s => s.stub('ui', { _res: 2.5 })
  const audioWorld = s => ({ world: { audio: s.stub('audio', { ctx: { currentTime: 10 }, lastDelta: 0.5 }) } })
  const dims = ['width', 'height', 'depth', 'radius']
  switch (type) {
    case 'node':
      return [
        {
          name: 'mounted, with its context',
          keys: ['active'],
          setup: (node, s) => {
            node.ctx = s.ctx()
            node.mounted = true
          },
        },
        {
          name: 'inactive, under a mounted parent',
          keys: ['active'],
          setup: (node, s) => {
            const parent = new s.m.Node()
            parent.ctx = s.ctx()
            parent.mounted = true
            node._active = false
            parent.add(node)
          },
        },
        {
          name: 'inactive, no parent, a context kept from before',
          keys: ['active'],
          setup: (node, s) => {
            node.ctx = s.ctx()
            node._active = false
          },
        },
        {
          name: 'its entity crashed',
          keys: ['onPointerEnter', 'onPointerLeave', 'onPointerDown', 'onPointerUp', 'cursor'],
          setup: node => (node.ctx = { entity: { crashed: true } }),
        },
      ]
    case 'uiview':
    case 'uitext':
    case 'uiimage':
      return [
        { name: 'in a ui (ui._res 2.5), no layout node', setup: (node, s) => (node.ui = ui(s)) },
        {
          name: 'laid out (ui._res 2.5, yogaNode)',
          setup: (node, s) => {
            node.ui = ui(s)
            node.yogaNode = s.stub('yoga')
          },
        },
        {
          name: 'laid out (ui._res 4, yogaNode)',
          keys: RES_KEYS[type],
          setup: (node, s) => {
            node.ui = s.stub('ui', { _res: 4 })
            node.yogaNode = s.stub('yoga')
          },
        },
      ]
    case 'ui':
      return [
        {
          name: 'laid out (_res 2.5, yogaNode)',
          setup: (node, s) => {
            node._res = 2.5
            node.yogaNode = s.stub('yoga')
          },
        },
        {
          name: 'laid out (_res 4, yogaNode)',
          keys: RES_KEYS.ui,
          setup: (node, s) => {
            node._res = 4
            node.yogaNode = s.stub('yoga')
          },
        },
      ]
    case 'audio':
      return [
        { name: 'an audio world, no source', setup: (node, s) => (node.ctx = audioWorld(s)) },
        {
          name: 'a source waiting for the audio unlock (offset 2)',
          setup: (node, s) => {
            node.ctx = audioWorld(s)
            node.source = s.stub('source')
            node.gainNode = s.stub('gain')
            node.pannerNode = s.stub('panner')
            node.offset = 2
          },
        },
        {
          name: 'a source playing (started at 4)',
          setup: (node, s) => {
            node.ctx = audioWorld(s)
            node.source = s.stub('source')
            node.gainNode = s.stub('gain')
            node.pannerNode = s.stub('panner')
            node.sourceStarted = true
            node.startTime = 4
          },
        },
      ]
    case 'video':
      return [
        {
          name: 'mounted (instance, mesh, gain, panner)',
          setup: (node, s) => {
            node.instance = s.stub('instance')
            node.mesh = s.stub('mesh')
            node.gain = s.stub('gain')
            node.panner = s.stub('panner')
          },
        },
        { name: 'loaded (_loading false)', keys: ['src'], setup: node => (node._loading = false) },
      ]
    case 'prim':
      return [
        { name: 'mounted (handle)', setup: (node, s) => (node.handle = s.stub('handle')) },
        ...['sphere', 'cylinder', 'cone', 'torus', 'plane'].map(t => ({
          name: `_type ${t}`,
          keys: ['size'],
          setup: node => (node._type = t),
        })),
      ]
    case 'mesh':
      return [
        { name: 'mounted (handle)', setup: (node, s) => (node.handle = s.stub('handle')) },
        ...['sphere', 'geometry'].flatMap(t => [
          { name: `_type ${t}`, keys: dims, setup: node => (node._type = t) },
          {
            name: `_type ${t}, mounted (handle)`,
            keys: dims,
            setup: (node, s) => {
              node._type = t
              node.handle = s.stub('handle')
            },
          },
        ]),
      ]
    case 'nametag':
      return [{ name: 'mounted (handle)', setup: (node, s) => (node.handle = s.stub('handle')) }]
    case 'collider':
      return [
        { name: 'mounted (shape)', setup: (node, s) => (node.shape = s.stub('shape')) },
        { name: "physics skipped ('size')", setup: node => (node.physicsSkipped = 'size') },
        ...['sphere', 'geometry'].flatMap(t => [
          {
            name: `_type ${t}, mounted (shape)`,
            keys: dims,
            setup: (node, s) => {
              node._type = t
              node.shape = s.stub('shape')
            },
          },
          {
            name: `_type ${t}, physics skipped ('size')`,
            keys: dims,
            setup: node => {
              node._type = t
              node.physicsSkipped = 'size'
            },
          },
        ]),
      ]
    case 'particles':
      return [{ name: 'mounted (emitter)', setup: (node, s) => (node.emitter = s.stub('emitter')) }]
    case 'controller':
      return [{ name: 'mounted (controller)', setup: (node, s) => (node.controller = s.stub('controller')) }]
    case 'avatar':
      return [{ name: 'mounted (instance)', setup: (node, s) => (node.instance = s.stub('instance')) }]
    case 'skinnedmesh':
      return [
        {
          name: 'mounted (obj with one mesh)',
          setup: (node, s) => {
            const mesh = s.stub('mesh', { isMesh: true })
            node.obj = { traverse: callback => callback(mesh) }
          },
        },
      ]
    default:
      return []
  }
}

// the methods the cases watch on the node under test (their calls, in order, by name)
const WATCHED = [
  'setDirty',
  'activate',
  'deactivate',
  'mount',
  'unmount',
  'remount',
  'rebuild',
  'redraw',
  'build',
  'unbuild',
  'play',
  'pause',
  'stop',
  'releaseSource',
  'applyShadows',
  'loadImage',
  'requestRebuild',
  'updatePannerPosition',
]

// ---------------------------------------------------------------------------------------------------------------------
// the text

const MAX_STRING = 40
const MAX_TRAPS = 24
const MAX_ITEMS = 16
const NO_ERROR = Symbol('no error')
// a callback's second value: a function of another name than the hostile list's
const SECOND_FN = () => function secondFn() {}

// the order in which the hostile values are tried for a property's sample value (rows b, d, g), after its own list:
// a callback before a flag before a number before nothing
const PREFERENCE = ['fn', 'false', 'true', '0.5', "'x'", '1', '[1,2,3]', '-1', '0', '1e9', "''", '{}', '[]']

// the first 12 hex digits of the sha256 of a text: what a shortened text says of what it leaves out
function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

// a node's id, where it is not an automatic one
function idTag(node) {
  return /^\d+$/.test(String(node.id)) ? '' : `#${node.id}`
}

function keyName(key) {
  return typeof key === 'symbol' ? `@${key.description}` : String(key)
}

function safeString(value) {
  try {
    return String(value)
  } catch {
    return null
  }
}

// an error as `Ctor: "message"`; a message that ends with the input (`invalid layer: x`) says `<in>` there
function errorText(err, rel) {
  if (err instanceof Error || (err && typeof err === 'object' && typeof err.message === 'string')) {
    let message = err.message
    if (rel) {
      const text = safeString(rel.input)
      if (text && message.endsWith(`: ${text}`)) message = `${message.slice(0, -text.length)}<in>`
    }
    return `${err.constructor?.name ?? 'Error'}: ${JSON.stringify(message)}`
  }
  return `thrown ${typeof err}`
}

// one run of the generator for one node type, in its own evaluation of the bundle
class Characterization {
  constructor(m, type, reference) {
    this.m = m
    this.type = type
    this.Type = type === 'node' ? m.Node : m.Nodes[type]
    // the node type's results (null while it is the one generated): another type's Node key that reads the same says
    // so in one line
    this.reference = reference
    this.blocks = { a: new Map(), c: new Map(), f: new Map(), fDefault: new Map(), fields: new Map(), i: new Map() }
    this.lines = []
    this.registry = new Map()
    this.loose = false
    // the case being run: its node, its input, and what its watchers, stubs and console wrote
    this.current = null
    const { stub, nameOf } = makeStubs(
      entry => this.current?.stubs.push(entry),
      value => this.describe(value, this.current?.rel, 'stub')
    )
    this.stubNameOf = nameOf
    this.s = { m, stub, ctx: () => ({ world: { stage: { dirtyNodes: new Set() } }, entity: null }) }
    this.cloneValues = new Map()
    this.baseTexts = new Map()
    this.secondValues = new Map()
    this.violations = []
    // what the console said outside a case: [row, entry]
    this.outside = []
    this.row = '-'
    // a subject made by subject(): the state it is in (its texts are read once per state)
    this.subjects = new WeakMap()
    this.watch()
    this.fixtures()
  }

  // every watched method of every node class records its calls on the node of the case
  watch() {
    for (const cls of [this.m.Node, ...Object.values(this.m.Nodes)]) {
      for (const name of WATCHED) {
        if (!Object.hasOwn(cls.prototype, name)) continue
        const original = cls.prototype[name]
        const characterization = this
        cls.prototype[name] = function (...args) {
          if (characterization.current && this === characterization.current.node) {
            characterization.current.calls.push(name)
          }
          return Reflect.apply(original, this, args)
        }
      }
    }
  }

  fixtures() {
    const { THREE, Nodes } = this.m
    const fx = { THREE }
    fx.geometryA = new THREE.BoxGeometry(1, 2, 3)
    this.registry.set(fx.geometryA, 'geometry#A')
    const geometryB = new THREE.BoxGeometry(3, 2, 1)
    this.registry.set(geometryB, 'geometry#B')
    const holder = new Nodes.mesh({ type: 'geometry', geometry: geometryB })
    fx.geometryRef = () => holder.getProxy().geometry
    fx.materialA = new THREE.MeshBasicMaterial()
    this.registry.set(fx.materialA, 'material#A')
    fx.otherNode = new this.m.Node({ id: 'other' })
    this.registry.set(fx.otherNode, 'node#other')
    fx.rigidbodyProxy = () => new Nodes.rigidbody().getProxy()
    fx.meshProxy = () => new Nodes.mesh().getProxy()
    fx.rigidbodyNode = () => new Nodes.rigidbody()
    const traps = (this.traps = { on: false, list: [] })
    // an array behind a Proxy that lists what the setter reads of it
    fx.trapArray = () => {
      const log = (kind, key) => traps.on && traps.list.push(`${kind}:${keyName(key)}`)
      return new Proxy([1, 2, 3], {
        get(target, key, receiver) {
          log('get', key)
          return Reflect.get(target, key, receiver)
        },
        has(target, key) {
          log('has', key)
          return Reflect.has(target, key)
        },
        ownKeys(target) {
          log('ownKeys', '')
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor(target, key) {
          log('gopd', key)
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
        set(target, key, value, receiver) {
          log('set', key)
          return Reflect.set(target, key, value, receiver)
        },
      })
    }
    this.fx = fx
  }

  // ---- canonical text of a value

  // `raw`: a script view's own text, read through it
  canon(value, depth = 0, seen = new Set(), raw = false) {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    switch (typeof value) {
      case 'number':
        return Object.is(value, -0) && !this.loose ? '-0' : String(value)
      case 'string':
        if (this.current?.node && value === this.current.node.id && /^\d+$/.test(value)) return '<auto id>'
        return value.length > MAX_STRING && !this.lossless
          ? `${JSON.stringify(value.slice(0, 8) + '…')}(len ${value.length} #${digest(value)})`
          : JSON.stringify(value)
      case 'boolean':
        return String(value)
      case 'bigint':
        return `${value}n`
      case 'symbol':
        return `Symbol(${value.description ?? ''})`
    }
    const label = this.registry.get(value)
    if (label) return label
    if (this.current?.node && value === this.current.node) return 'self'
    const stubName = this.stubNameOf(value)
    if (stubName) return `stub:${stubName}`
    if (!raw && this.m.isScriptView(value)) return `view:${this.canon(value, depth, seen, true)}`
    if (!raw && utilTypes.isProxy(value)) {
      const node = this.m.getNodeRef(value)
      if (node) return node === this.current?.node ? 'proxy:self' : `proxy:${node.name}${idTag(node)}`
      return 'Proxy'
    }
    if (seen.has(value)) return '<cycle>'
    const flags = Object.isFrozen(value) ? 'F' : Object.isSealed(value) ? 'S' : ''
    if (typeof value === 'function') return `fn:${value.name || '<anon>'}${flags}`
    if (utilTypes.isBoxedPrimitive(value)) {
      return `${Object.prototype.toString.call(value).slice(8, -1)}(${this.canon(value.valueOf())})`
    }
    const plainObject = [Object.prototype, null].includes(Object.getPrototypeOf(value))
    if (plainObject) return this.plain(value, flags, depth, seen)
    if (value.isVector3) return `V3(${this.nums(value.x, value.y, value.z)})${flags}`
    if (value.isVector2) return `V2(${this.nums(value.x, value.y)})${flags}`
    if (value.isQuaternion) return `Q(${this.nums(value.x, value.y, value.z, value.w)})${flags}`
    if (value.isEuler) return `E(${this.nums(value.x, value.y, value.z)},${value.order})${flags}`
    if (value.isColor) return `Color(${value.getHexString()})`
    if (value.isMatrix4) {
      const identity = value.elements.every((e, i) => e === (i % 5 === 0 ? 1 : 0))
      return `M4(${identity ? 'I' : this.nums(...value.elements)})${flags}`
    }
    if (value.isBufferGeometry || value.isMaterial || value.isObject3D) return `<${value.type}>`
    if (typeof value.getProxy === 'function' && Array.isArray(value.children)) {
      // (a descendant of the case's node is marked: a clone's levels and children are its own, not its source's)
      let up = value.parent
      for (let steps = 0; up && steps < 64 && up !== this.current?.node; steps++) up = up.parent
      return `node:${value.name}${idTag(value)}${up && up === this.current?.node ? '(below)' : ''}`
    }
    if (value instanceof Error) return `${value.constructor.name}(${JSON.stringify(value.message)})`
    if (value instanceof Set) return `Set(${value.size})`
    if (value instanceof Map) return `Map(${value.size})`
    if (value instanceof Promise) return 'Promise'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        if (depth >= 3 && !this.lossless) return `[…${value.length} #${digest(this.losslessText(value))}]${flags}`
        const item = i => (i in value ? this.canon(value[i], depth + 1, seen) : '<hole>')
        // (a long one: its first three items, its last, its length, and the digest of all of it)
        if (value.length > MAX_ITEMS && !this.lossless) {
          const all = digest(this.losslessText(value))
          return `[${[0, 1, 2].map(item).join(',')},…,${item(value.length - 1)}](len ${value.length} #${all})${flags}`
        }
        const items = []
        for (let i = 0; i < value.length; i++) items.push(item(i))
        return `[${items.join(',')}]${flags}`
      }
      return `<${Object.getPrototypeOf(value)?.constructor?.name ?? 'object'}>${flags}`
    } finally {
      seen.delete(value)
    }
  }

  // a plain object: a node's proxy, a value ref (what it resolves to), or its own properties
  plain(value, flags, depth, seen) {
    // (the case's node's own proxy by identity: getNodeRef asks the node's getProxy(), which must not be called while a
    // case reads its node, row h)
    if (this.current?.node && value === this.current.node._proxy) return 'proxy:self'
    const node = this.m.getNodeRef(value)
    if (node) return node === this.current?.node ? 'proxy:self' : `proxy:${node.name}${idTag(node)}`
    const ref = this.m.resolveValueRef(value)
    if (ref) return `ref(${this.canon(ref.value, depth + 1, seen)})${flags}`
    if (depth >= 3 && !this.lossless) return `{… #${digest(this.losslessText(value))}}${flags}`
    if (seen.has(value)) return '<cycle>'
    seen.add(value)
    try {
      const parts = []
      for (const key of Reflect.ownKeys(value)) {
        const desc = Reflect.getOwnPropertyDescriptor(value, key)
        parts.push(`${keyName(key)}:${desc.get || desc.set ? '<accessor>' : this.canon(desc.value, depth + 1, seen)}`)
      }
      return `{${parts.join(',')}}${flags}`
    } finally {
      seen.delete(value)
    }
  }

  // the text of a value with nothing left out (no length or depth limit): what a digest is taken of
  losslessText(value) {
    const was = this.lossless
    this.lossless = true
    try {
      return this.canon(value)
    } finally {
      this.lossless = was
    }
  }

  // a value's text, and, for a plain object with getters (a script's material), what each getter reads
  deep(value) {
    let text = this.canon(value)
    const plain =
      value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    if (!plain || this.m.getNodeRef(value) || this.m.resolveValueRef(value)) return text
    const reads = []
    for (const key of Reflect.ownKeys(value)) {
      if (!Reflect.getOwnPropertyDescriptor(value, key).get) continue
      try {
        reads.push(`${keyName(key)}=${this.canon(value[key])}`)
      } catch (err) {
        reads.push(`${keyName(key)}=throws ${errorText(err)}`)
      }
    }
    if (reads.length) text += ` reads{${reads.join(' ')}}`
    return text
  }

  nums(...values) {
    return values.map(v => this.canon(v)).join(',')
  }

  // a value against the case's input `rel`: `$in` for the input itself, `$in~` for an equal copy of an object input.
  // An object is the input by identity everywhere; a primitive only where `level` says: 'own' (the property's read
  // and its own field: any primitive), 'stub' (what a stub was given: a string; a number there is often computed, and
  // one that happens to equal the input is not the input), 'other' (another field: none)
  describe(value, rel, level = 'other') {
    if (!rel) return this.canon(value)
    const kind = typeof value
    const object = value !== null && (kind === 'object' || kind === 'function')
    if (Object.is(value, rel.input)) {
      if (object || level === 'own' || (level === 'stub' && kind === 'string')) return '$in'
    }
    const text = this.canon(value)
    if (object && text === rel.inputText) return '$in~'
    return text
  }

  // ---- own fields: their values, and the text of each object field taken at once (a setter can change one in place)

  // `texts`: the texts of the object fields when a node in that very state was read before (every subject of a
  // scenario starts alike)
  snapshot(node, texts = null) {
    const fields = new Map()
    const descriptors = Object.getOwnPropertyDescriptors(node)
    for (const key of Reflect.ownKeys(descriptors)) {
      const desc = descriptors[key]
      // (a field that is not enumerable, writable or configurable, as a class field or an assignment makes it, says so)
      const flags = `${desc.enumerable ? '' : '!enum'}${desc.writable === false ? '!writable' : ''}${desc.configurable ? '' : '!conf'}`
      if (desc.get || desc.set) fields.set(key, { accessor: true, flags })
      else {
        const value = desc.value
        const object = value !== null && (typeof value === 'object' || typeof value === 'function')
        fields.set(key, { value, flags, text: object ? (texts?.get(key) ?? this.canon(value)) : null })
      }
    }
    return fields
  }

  fieldText(entry, rel, level) {
    if (entry.accessor) return `<accessor>${entry.flags}`
    return this.describe(entry.value, rel, level) + entry.flags
  }

  // the own fields a case changed: `name:value` for a changed or new one, `name:<deleted>` for one that went
  delta(before, after, rel, key) {
    const parts = []
    const own = key === undefined ? [] : [keyName(key), `_${keyName(key)}`, OWN_FIELDS[this.type]?.[keyName(key)]]
    for (const [field, entry] of after) {
      const prior = before.get(field)
      const level = own.includes(keyName(field)) ? 'own' : 'other'
      if (prior && prior.accessor && entry.accessor && prior.flags === entry.flags) continue
      if (
        prior &&
        !prior.accessor &&
        !entry.accessor &&
        Object.is(prior.value, entry.value) &&
        prior.flags === entry.flags
      ) {
        // the same object: changed in place?
        if (entry.text === null || this.canon(entry.value) === prior.text) continue
      }
      parts.push(`${keyName(field)}:${this.fieldText(entry, rel, level)}`)
    }
    for (const field of before.keys()) if (!after.has(field)) parts.push(`${keyName(field)}:<deleted>`)
    return parts
  }

  // ---- one case

  // a fresh node, its proxy made, the state of `scenario` set up, its flags reset: a case's subject
  // (the class path's subject has no proxy made)
  subject(scenario, path = 'p') {
    const node = new this.Type()
    if (path === 'p') node.getProxy()
    if (scenario) scenario.setup(node, this.s)
    if (node.needsRebuild) node.needsRebuild = false
    if (node.needsRedraw) node.needsRedraw = false
    this.subjects.set(node, `${scenario?.name ?? ''}|${path}`)
    return node
  }

  begin(node, rel = null) {
    this.current = { node, rel, calls: [], stubs: [], console: [] }
    return this.current
  }

  end() {
    this.current = null
  }

  consoleText(entries) {
    return entries.length ? ` log[${entries.join(' ')}]` : ''
  }

  // `key` set to the value `make` gives, on `node` through `path` ('p' the proxy, 'c' the class): the error, or the
  // value read back; the own fields changed; the watched calls; what the stubs recorded; the reads of a Proxy input;
  // the console. `quiet`: a read of the input itself is not said (row d)
  setCase(node, path, key, make, { quiet = false } = {}) {
    const state = this.subjects.get(node)
    this.subjects.delete(node)
    const target = path === 'p' ? node.getProxy() : node
    const input = make(this.fx)
    const rel = { input, inputText: this.canon(input) }
    const current = this.begin(node, rel)
    const before = this.snapshot(node, state && this.baseTexts.get(state))
    if (state && !this.baseTexts.has(state)) {
      this.baseTexts.set(state, new Map([...before].filter(([, e]) => e.text != null).map(([k, e]) => [k, e.text])))
    }
    this.traps.list.length = 0
    this.traps.on = true
    let error = NO_ERROR
    try {
      target[key] = input
    } catch (err) {
      error = err
    } finally {
      this.traps.on = false
    }
    const parts = []
    // what row f compares with the constructor: the error or the value read once, and the console until then
    let reduced
    let said = current.console.length
    if (error !== NO_ERROR) {
      reduced = `throw ${errorText(error, rel)}`
      parts.push(reduced)
    } else {
      try {
        const first = target[key]
        said = current.console.length
        reduced = this.describe(first, rel, 'own')
        const second = target[key]
        const fresh = first !== null && typeof first === 'object' && first !== second ? ' fresh' : ''
        if (!(quiet && reduced === '$in')) parts.push(`read ${reduced}${fresh}`)
      } catch (err) {
        said = current.console.length
        reduced = `read throws ${errorText(err, rel)}`
        parts.push(reduced)
      }
    }
    this.reduced = reduced + this.consoleText(current.console.slice(0, said))
    const delta = this.delta(before, this.snapshot(node), rel, key)
    if (delta.length) parts.push(`Δ{${delta.join(' ')}}`)
    if (current.calls.length) parts.push(`calls[${current.calls.join(',')}]`)
    if (current.stubs.length) parts.push(`stub[${current.stubs.join(' ')}]`)
    const traps = this.traps.list
    if (traps.length) {
      const shown = traps.slice(0, MAX_TRAPS).join(',')
      const rest = `,…+${traps.length - MAX_TRAPS} #${digest(traps.join(','))}`
      parts.push(`traps[${shown}${traps.length > MAX_TRAPS ? rest : ''}]`)
    }
    const text = parts.join(' ') + this.consoleText(current.console)
    this.end()
    return text
  }

  // ---- the keys and values

  isNodeKey(key) {
    return this.type !== 'node' && this.nodeKeys.has(key)
  }

  validOf(key) {
    if (this.nodeKeys.has(key)) return NODE_VALID[key] || []
    return VALID[this.type][key] || []
  }

  // the hostile list, then the property's own values (a label already there is not repeated)
  values(key) {
    const out = [...HOSTILE]
    const seen = new Set(HOSTILE.map(([label]) => label))
    for (const make of this.validOf(key)) {
      const value = make(this.fx)
      const label = typeof value === 'string' && value.length <= MAX_STRING ? `'${value}'` : this.canon(value)
      if (seen.has(label)) continue
      seen.add(label)
      out.push([label, make])
    }
    return out
  }

  // the property's sample value: the first of its own values, then of the hostile list (PREFERENCE first), that the
  // proxy accepts and that reads back otherwise than the default
  cloneValue(key) {
    if (!this.cloneValues.has(key)) {
      const fallback = this.readKey(this.withSetup(new this.Type(), null), key)
      this.cloneValues.set(key, this.pickValue(key, null, [fallback], false))
    }
    return this.cloneValues.get(key)
  }

  // a second value of the key, accepted and reading otherwise than the first sample (the default may be it; a callback
  // gets a function of another name)
  secondValue(key, setup = null) {
    const id = `${keyName(key)}|${setup ? 'mounted' : ''}`
    if (!this.secondValues.has(id)) {
      const first = setup ? this.mountedValue(key, setup) : this.cloneValue(key)
      let chosen = null
      if (first) {
        const node = this.withSetup(new this.Type(), setup)
        node.getProxy()[key] = first(this.fx)
        chosen = this.pickValue(key, setup, [this.readKey(node, key)], true)
      }
      this.secondValues.set(id, chosen)
    }
    return this.secondValues.get(id)
  }

  // the first sample of a key that takes a value only in the state `setup` makes
  mountedValue(key, setup) {
    const id = `${keyName(key)}|mounted`
    if (!this.cloneValues.has(id)) {
      const fallback = this.readKey(this.withSetup(new this.Type(), setup), key)
      this.cloneValues.set(id, this.pickValue(key, setup, [fallback], false))
    }
    return this.cloneValues.get(id)
  }

  // the first value (a callback of another name first, when `second`), of the key's own list, then of the hostile list,
  // that the proxy accepts on a node in the state `setup` makes, and that reads otherwise than each of `avoid`
  pickValue(key, setup, avoid, second) {
    const hostile = [...HOSTILE].sort((a, b) => rank(a[0]) - rank(b[0])).map(([, make]) => make)
    const candidates = [...(second ? [SECOND_FN] : []), ...this.validOf(key), ...hostile]
    for (const make of candidates) {
      const node = this.withSetup(new this.Type(), setup)
      try {
        node.getProxy()[key] = make(this.fx)
      } catch {
        continue
      }
      if (!avoid.includes(this.readKey(node, key))) return make
    }
    return null
  }

  withSetup(node, setup) {
    if (setup) setup(node)
    return node
  }

  readProxy(proxy, key) {
    try {
      return this.canon(proxy[key])
    } catch (err) {
      return `read throws ${errorText(err)}`
    }
  }

  // a key read through the proxy, or through the class where the proxy has no getter for it
  readKey(node, key) {
    const proxy = node.getProxy()
    if (Reflect.getOwnPropertyDescriptor(proxy, key)?.get) return this.readProxy(proxy, key)
    return this.readProxy(node, key)
  }

  // ---- output

  line(text) {
    this.lines.push(text)
  }

  // lines of `prefix outcome <- labels`, the outcomes in the order of their first label
  grouped(prefix, outcomes) {
    const groups = new Map()
    for (const [label, outcome] of outcomes) {
      if (!groups.has(outcome)) groups.set(outcome, [])
      groups.get(outcome).push(label)
    }
    return [...groups].map(([outcome, labels]) => `${prefix}${outcome} <- ${labels.join(' ')}`)
  }

  // the values the proxy and the class handle alike (pc), then those they do not (p, c)
  pathLines(prefix, p, c) {
    const both = []
    const proxyOnly = []
    const classOnly = []
    p.forEach(([label, text], i) => {
      if (text === c[i][1]) both.push([label, text])
      else {
        proxyOnly.push([label, text])
        classOnly.push([label, c[i][1]])
      }
    })
    return [
      ...this.grouped(`${prefix}pc `, both),
      ...this.grouped(`${prefix}p `, proxyOnly),
      ...this.grouped(`${prefix}c `, classOnly),
    ]
  }

  // a key's lines; a Node key of another type whose lines are those of the node type is listed in `same` instead
  block(row, key, lines, same) {
    const name = keyName(key)
    this.blocks[row].set(name, lines)
    if (this.isNodeKey(key)) {
      const ref = this.reference[row].get(name)
      if (ref && ref.length === lines.length && ref.every((l, i) => l === lines[i])) {
        same.push(name)
        return
      }
    }
    for (const l of lines) this.line(l)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the rows

  run() {
    const proxy = new this.Type().getProxy()
    const desc = key => Reflect.getOwnPropertyDescriptor(proxy, key)
    this.keys = Reflect.ownKeys(proxy)
    this.nodeKeys = new Set(Reflect.ownKeys(new this.m.Node().getProxy()))
    this.setters = this.keys.filter(key => desc(key).set)
    this.getters = this.keys.filter(key => desc(key).get)
    this.line(`# the '${this.type}' node type, written by test/lib/nodeGolden.mjs (legend: test/nodeGolden.test.js)`)
    for (const row of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']) {
      this.row = row.toLowerCase()
      this[`row${row}`]()
    }
    this.row = '-'
    this.rowX()
  }

  // a. the proxy's own keys in order, their descriptors, and which functions two instances share
  rowA() {
    this.line('== a. the proxy: own keys in order, descriptors, functions shared by two instances')
    const node = new this.Type()
    const proxyA = node.getProxy()
    const proxyB = new this.Type().getProxy()
    const proto = Object.getPrototypeOf(proxyA)
    const protoName = proto === Object.prototype ? 'Object.prototype' : proto === null ? 'null' : 'another'
    this.line(
      `a proxy: prototype ${protoName}, extensible ${Object.isExtensible(proxyA)}, frozen ${Object.isFrozen(proxyA)}, ` +
        `${this.keys.length} keys, getNodeRef(proxy) is the node: ${this.m.getNodeRef(proxyA) === node}`
    )
    const describe = key => {
      const a = Reflect.getOwnPropertyDescriptor(proxyA, key)
      const b = Reflect.getOwnPropertyDescriptor(proxyB, key)
      const kind =
        a.get && a.set ? 'get+set' : a.get ? 'get' : a.set ? 'set' : typeof a.value === 'function' ? 'method' : 'data'
      const parts = [kind, a.enumerable ? 'enum' : '!enum', a.configurable ? 'conf' : '!conf']
      if ('value' in a) parts.push(a.writable ? 'writable' : '!writable')
      for (const role of ['get', 'set', 'value']) {
        const fn = a[role]
        if (typeof fn !== 'function') continue
        const shared = fn === b[role] ? 'shared' : 'per-instance'
        parts.push(`${role === 'value' ? 'fn' : role}:${JSON.stringify(fn.name)}/${fn.length} ${shared}`)
      }
      if ('value' in a && typeof a.value !== 'function') parts.push(`value ${this.canon(a.value)}`)
      return parts.join(' ')
    }
    const positions = []
    const differing = []
    this.keys.forEach((key, i) => {
      const text = describe(key)
      this.blocks.a.set(keyName(key), text)
      if (!this.isNodeKey(key)) this.line(`a ${i + 1} ${keyName(key)}: ${text}`)
      else {
        positions.push(i + 1)
        if (this.reference.a.get(keyName(key)) !== text) differing.push(`a ${i + 1} ${keyName(key)}: ${text}`)
      }
    })
    if (this.type !== 'node') {
      const order = this.keys.filter(key => this.isNodeKey(key)).map(keyName)
      const sameOrder = order.join(',') === [...this.nodeKeys].map(keyName).join(',')
      this.line(
        `a node keys: ${positions.length} at ${positions.join(',')}; order ${sameOrder ? 'as on node' : order.join(',')}; ` +
          `descriptors ${differing.length ? 'differ:' : 'as on node'}`
      )
      for (const text of differing) this.line(text)
    }
  }

  // b. a stopped run: what every setter and method does, with the node's own fields before and after and the watched
  // calls, when the run is the node's context's, the one it was made for (_created), or its parent's context's; what
  // every getter reads in the first; a live run; and the receivers a setter can be called on
  rowB() {
    this.line("== b. a stopped run (ctx.run is not its entity's deadHook), a live run, and receivers")
    const stoppedCtx = () => ({ run: { ended: true }, entity: { deadHook: { live: true } } })
    const places = [
      ['', n => (n.ctx = stoppedCtx()), ['set', 'method', 'get']],
      ['through _created ', n => (n._created = stoppedCtx()), ['set', 'method']],
      [
        'through a parent ',
        n => {
          const parent = new this.m.Node()
          parent.ctx = stoppedCtx()
          n.parent = parent
        },
        ['set', 'method'],
      ],
    ]
    const probe = new this.Type().getProxy()
    for (const [where, place, roles] of places) {
      const results = []
      for (const key of this.keys) {
        const d = Reflect.getOwnPropertyDescriptor(probe, key)
        if (d.set && roles.includes('set')) results.push(['set', this.stopped(place, key, 'set'), keyName(key)])
        if (typeof d.value === 'function' && roles.includes('method')) {
          results.push(['method', this.stopped(place, key, 'method'), keyName(key)])
        }
        if (d.get && roles.includes('get')) results.push(['get', this.stopped(place, key, 'get'), keyName(key)])
      }
      for (const role of roles) {
        const groups = new Map()
        for (const [r, text, name] of results) {
          if (r !== role) continue
          if (!groups.has(text)) groups.set(text, [])
          groups.get(text).push(name)
        }
        const total = results.filter(([r]) => r === role).length
        for (const [text, names] of groups) {
          const list = where && names.length === total ? `all ${total}` : names.join(' ')
          this.line(`b ${where}${role} ${text}: ${list}`)
        }
      }
    }
    // a live run (ctx.run is its entity's deadHook): each setter takes its sample value
    const refused = []
    for (const key of this.setters) {
      const make = this.cloneValue(key)
      if (!make) continue
      const value = make(this.fx)
      const n = new this.Type()
      const p = n.getProxy()
      const run = {}
      n.ctx = { run, entity: { deadHook: run } }
      this.begin(n)
      try {
        p[key] = value
      } catch (err) {
        refused.push(`${keyName(key)} (${errorText(err)})`)
      }
      this.end()
    }
    this.line(
      `b a live run: each setter with a sample value takes it${refused.length ? ', but ' + refused.join(' ') : ''}`
    )
    this.receivers()
  }

  // one get, set (of the key's sample value) or call (with no arguments) on a new node placed in a stopped run: what it
  // did, the node's own fields it changed, the watched calls, the console
  stopped(place, key, role) {
    const node = new this.Type()
    const proxy = node.getProxy()
    place(node)
    const make = role === 'set' ? (this.cloneValue(key) ?? (() => 1)) : null
    const value = make ? make(this.fx) : undefined
    const current = this.begin(node)
    const before = this.snapshot(node)
    let text
    try {
      if (role === 'get') text = `reads ${this.canon(proxy[key])}`
      else if (role === 'set') {
        proxy[key] = value
        text = 'runs'
      } else {
        Reflect.getOwnPropertyDescriptor(proxy, key).value.call(proxy)
        text = 'runs'
      }
    } catch (err) {
      text = `throws ${errorText(err)}`
    }
    const delta = this.delta(before, this.snapshot(node))
    if (delta.length) text += ` Δ{${delta.join(' ')}}`
    if (current.calls.length) text += ` calls[${current.calls.join(',')}]`
    text += this.consoleText(current.console)
    this.end()
    return text
  }

  // a handle that inherits from the proxy; a plain object; none; a group's handle; the handle of another type that
  // has the key
  receivers() {
    if (!this.setters.length) return
    const asDirect = []
    const notAsDirect = []
    const maps = { 'a plain object': new Map(), 'no receiver': new Map(), "a group's proxy": new Map() }
    const other = new Map()
    const add = (map, text, name) => {
      if (!map.has(text)) map.set(text, [])
      map.get(text).push(name)
    }
    const attempt = fn => {
      try {
        return fn()
      } catch (err) {
        return `throws ${errorText(err)}`
      }
    }
    for (const key of this.setters) {
      const name = keyName(key)
      const make = this.cloneValue(key) ?? (() => 1)
      const direct = new this.Type().getProxy()
      const directText = attempt(() => {
        direct[key] = make(this.fx)
        return this.readProxy(direct, key)
      })
      const proxy = new this.Type().getProxy()
      const childText = attempt(() => {
        Object.create(proxy)[key] = make(this.fx)
        return this.readProxy(proxy, key)
      })
      if (childText === directText) asDirect.push(name)
      else notAsDirect.push(`${name} (${childText}; through the proxy ${directText})`)
      const set = Reflect.getOwnPropertyDescriptor(proxy, key).set
      const call = receiver =>
        attempt(() => {
          set.call(receiver, make(this.fx))
          return 'runs'
        })
          .replace(`no ${name} to set`, 'no <key> to set')
          .replace(`replace node ${name}`, 'replace node <key>')
          .replace(`set ${name} directly`, 'set <key> directly')
      add(maps['a plain object'], call({}), name)
      add(maps['no receiver'], call(undefined), name)
      if (this.type !== 'group') add(maps["a group's proxy"], call(new this.m.Nodes.group().getProxy()), name)
      if (this.isNodeKey(key) || this.type === 'node') continue
      // the same name on the first other type that has it: the shared setter finds that node's own setter
      const otherType = NODE_TYPES.find(
        t =>
          t !== this.type &&
          t !== 'node' &&
          Reflect.getOwnPropertyDescriptor(new this.m.Nodes[t]().getProxy(), key)?.set
      )
      if (!otherType) continue
      const otherProxy = new this.m.Nodes[otherType]().getProxy()
      const was = this.readProxy(otherProxy, key)
      const text = attempt(() => {
        set.call(otherProxy, make(this.fx))
        return this.readProxy(otherProxy, key) === was ? 'leaves that node as it was' : 'sets that node'
      })
      add(other, text, `${name}(${otherType})`)
    }
    this.line(
      `b receiver Object.create(proxy): as through the proxy: ${asDirect.length} of ${this.setters.length}` +
        (notAsDirect.length ? `; otherwise: ${notAsDirect.join(' ')}` : '')
    )
    for (const [where, map] of [...Object.entries(maps), ["another type's proxy with the key", other]]) {
      for (const [text, names] of map) {
        const list = names.length === this.setters.length ? `all ${names.length}` : names.join(' ')
        this.line(`b receiver ${where}: ${text}: ${list}`)
      }
    }
  }

  // c. one set on a fresh unmounted node, through the proxy and through the class
  rowC() {
    this.line('== c. one set on a fresh unmounted node: pc the proxy and the class alike, p the proxy, c the class')
    this.outcomesC = new Map()
    const same = []
    for (const key of this.setters) {
      const p = []
      const c = []
      const reduced = []
      for (const [label, make] of this.values(key)) {
        p.push([label, this.setCase(this.subject(), 'p', key, make)])
        c.push([label, this.setCase(this.subject(null, 'c'), 'c', key, make)])
        reduced.push([label, this.reduced])
      }
      this.outcomesC.set(key, { p, c, reduced })
      this.block('c', key, this.pathLines(`c ${keyName(key)} `, p, c), same)
    }
    if (same.length) this.line(`c as on node: ${same.join(' ')}`)
  }

  // d. a second set after a first (flags and records reset in between): the same value again, an equal new object,
  // NaN twice, 0 then -0. What the second set did shows the equality check, if any, before the effect.
  rowD() {
    this.line('== d. a second set: same (the same value), copy (an equal new object), NaN then NaN, 0 then -0')
    const states = [
      null,
      ...scenarios(this.type)
        .filter(s => !s.keys)
        .slice(0, 1),
    ]
    for (const scenario of states) {
      for (const key of this.setters) {
        if (this.isNodeKey(key)) continue
        const make = this.cloneValue(key)
        const parts = []
        if (make) {
          parts.push(`same: ${this.twice(scenario, key, make, true)}`)
          const sample = make(this.fx)
          if (sample !== null && typeof sample === 'object')
            parts.push(`copy: ${this.twice(scenario, key, make, false)}`)
        }
        parts.push(`NaN,NaN: ${this.twice(scenario, key, () => NaN, false)}`)
        parts.push(
          `0,-0: ${this.twice(
            scenario,
            key,
            () => 0,
            false,
            () => -0
          )}`
        )
        this.line(`d ${keyName(key)}${scenario ? ` [${scenario.name}]` : ''} ${parts.join(' | ')}`)
      }
    }
  }

  // the first set, then the second: the very value of the first (`same`), or what `next` (or `first` again) gives
  twice(scenario, key, first, same, next = first) {
    const node = this.subject(scenario)
    this.subjects.delete(node)
    let value
    try {
      value = first(this.fx)
      node.getProxy()[key] = value
    } catch (err) {
      return `first throws ${errorText(err)}`
    }
    if (node.needsRebuild) node.needsRebuild = false
    if (node.needsRedraw) node.needsRedraw = false
    return this.setCase(node, 'p', key, same ? () => value : next, { quiet: true }) || '-'
  }

  // e. the same sets on a node in a mounted-like state (the stubs record what is done to them): what differs from c
  rowE() {
    const list = scenarios(this.type)
    if (!list.length) return
    this.line('== e. the sets of c in a mounted-like state (stubs record what is done to them): what differs from c')
    for (const scenario of list) {
      this.line(`e [${scenario.name}]`)
      const asInC = []
      for (const key of this.setters) {
        if (scenario.keys ? !scenario.keys.includes(key) : this.isNodeKey(key)) continue
        const base = this.outcomesC.get(key)
        const p = []
        const c = []
        for (const [label, make] of this.values(key)) {
          p.push([label, this.setCase(this.subject(scenario), 'p', key, make)])
          c.push([label, this.setCase(this.subject(scenario, 'c'), 'c', key, make)])
        }
        const changed = new Set(
          p.filter(([, text], i) => text !== base.p[i][1] || c[i][1] !== base.c[i][1]).map(([label]) => label)
        )
        if (!changed.size) {
          asInC.push(keyName(key))
          continue
        }
        const pick = list => list.filter(([label]) => changed.has(label))
        for (const l of this.pathLines(`e ${keyName(key)} `, pick(p), pick(c))) this.line(l)
        if (changed.size < p.length) this.line(`e ${keyName(key)}: the other ${p.length - changed.size} as in c`)
      }
      if (asInC.length) this.line(`e as in c: ${asInC.join(' ')}`)
    }
  }

  // f. the constructor: the defaults read through the proxy; each settable key given through `data` (against the
  // same value set through the class on a new node); the host-only data a loader gives
  rowF() {
    this.line('== f. the constructor: defaults (read through the proxy); each key given through data')
    const node = new this.Type()
    const proxy = node.getProxy()
    const sameDefaults = []
    for (const key of this.getters) {
      if (key === '_ref') continue
      this.begin(node)
      let text
      try {
        const value = proxy[key]
        const again = proxy[key]
        text = this.canon(value) + (value !== null && typeof value === 'object' && value !== again ? ' fresh' : '')
      } catch (err) {
        text = `read throws ${errorText(err)}`
      }
      text += this.consoleText(this.current.console)
      this.end()
      this.block('fDefault', key, [`f default ${keyName(key)} = ${text}`], sameDefaults)
    }
    if (sameDefaults.length) this.line(`f defaults as on node: ${sameDefaults.join(' ')}`)
    const same = []
    for (const key of this.setters) this.ctorKey(key, same)
    if (same.length) this.line(`f as on node: ${same.join(' ')}`)
    for (const [key, field] of Object.entries(HOST_CTOR_KEYS[this.type] || {})) {
      const outcomes = HOSTILE.map(([label, make]) => [label, this.construct(key, make, node => node[field])])
      for (const l of this.grouped(`f ${key} (host-only data, read as ${field}) `, outcomes)) this.line(l)
    }
  }

  // (the class side is row c's set through the class: the error or the value read once, and the console)
  ctorKey(key, same) {
    const ctor = this.values(key).map(([label, make]) => [label, this.construct(key, make, node => node[key])])
    const cls = this.outcomesC.get(key).reduced
    const alike = ctor.every(([, text], i) => text === cls[i][1])
    const name = keyName(key)
    const lines = alike
      ? [`f ${name}: through data as through the class (all ${ctor.length})`]
      : this.grouped(`f ${name} data `, ctor)
    this.block('f', key, lines, same)
  }

  construct(key, make, read) {
    const input = make(this.fx)
    const rel = { input, inputText: this.canon(input) }
    this.begin(null, rel)
    let text
    try {
      const node = new this.Type({ [key]: input })
      this.current.node = node
      try {
        text = this.describe(read(node), rel, 'own')
      } catch (err) {
        text = `read throws ${errorText(err, rel)}`
      }
    } catch (err) {
      text = `throw ${errorText(err, rel)}`
    }
    text += this.consoleText(this.current.console)
    this.end()
    return text
  }

  // g. own fields after construction; clone() and clone(true) of a node with every property set, of nodes built the
  // way glbToNodes builds them and of the host-only fields other loaders give; and whether a clone keeps every
  // proxy-settable property
  rowG() {
    this.line('== g. own fields after construction, and what clone() and clone(true) make of them')
    const node = new this.Type()
    this.begin(node)
    const asOnNode = []
    for (const [key, entry] of this.snapshot(node)) {
      const name = keyName(key)
      const text = this.fieldText(entry)
      this.blocks.fields.set(name, text)
      if (this.type !== 'node' && this.reference.fields.get(name) === text) asOnNode.push(name)
      else this.line(`g field ${name} = ${text}`)
    }
    this.end()
    if (asOnNode.length) this.line(`g fields as on node: ${asOnNode.join(' ')}`)
    // every settable property set (in key order) on one node, with one child; its own transform, id, the run it was made
    // for, and the fields a script cannot set (a joint's frames) away from a new node's too
    const full = new this.Type()
    full.id = 'full'
    this.transform(full, [1, 2, 3], [0, 0.6, 0, 0.8], [2, 3, 4])
    const owner = { entity: {} }
    this.registry.set(owner, 'owner#full')
    full._created = owner
    this.hostFields(full)
    const proxy = full.getProxy()
    const set = []
    for (const key of this.setters) {
      const make = this.cloneValue(key)
      if (!make) continue
      try {
        proxy[key] = make(this.fx)
        set.push(keyName(key))
      } catch {
        // (a value an earlier set made invalid: not set)
      }
    }
    full.add(new this.m.Node({ id: 'child', position: [4, 5, 6], quaternion: [0.6, 0, 0, 0.8], scale: [3, 3, 3] }))
    this.line(`g full: ${set.length} properties set (${set.join(' ') || '-'}), one child`)
    const none = this.setters.filter(key => !this.cloneValue(key)).map(keyName)
    if (none.length)
      this.line(`g no sample value (no value accepted reads otherwise than the default): ${none.join(' ')}`)
    this.cloneLines('g full', full, true)
    for (const [name, made] of this.hostNodes()) this.cloneLines(`g ${name}`, made)
    // each proxy-settable property alone, cloned both ways: every getter reads as on the source (-0 as 0: a clone's
    // rotation is made again from its quaternion)
    const violations = []
    let checked = 0
    this.loose = true
    try {
      for (const key of this.setters) {
        const make = this.cloneValue(key)
        if (!make) continue
        const source = new this.Type()
        this.transform(source, [1, 2, 3], [0, 0.6, 0, 0.8], [2, 3, 4])
        this.hostFields(source)
        try {
          source.getProxy()[key] = make(this.fx)
        } catch {
          continue
        }
        for (const recursive of [false, true]) {
          checked++
          const copy = source.clone(recursive)
          for (const read of new Set([...this.getters, ...this.setters])) {
            if (['_ref', 'parent', 'children'].includes(read)) continue
            const a = this.readKey(source, read)
            const b = this.readKey(copy, read)
            if (a !== b) violations.push(`${keyName(key)} clone(${recursive}): ${keyName(read)} ${a} -> ${b}`)
          }
        }
      }
    } finally {
      this.loose = false
    }
    this.violations.push(...violations)
    this.line(
      `g a clone reads as its source, each sample property alone (${checked} clones): ${violations.length ? 'no' : 'yes'}`
    )
    for (const v of violations) this.line(`g clone differs: ${v}`)
  }

  // h. two nodes of the type alive at once, their proxies kept: a write through the first one's, then through the second
  // one's (a second value that reads otherwise), each read back through both kept proxies (and again after each node's
  // getProxy() was asked once more), and the other node's own fields compared before and after. A key that takes a
  // value only on a mounted node is paired in that state, with a stand-in of its own for each node. Then the get-only
  // keys, and those no script can set, read through both kept proxies of two nodes in distinct states.
  rowH() {
    this.line('== h. two instances alive at once, their proxies kept: each write and read reaches its own node only')
    const fine = []
    const noSecond = []
    const noValue = []
    const keys = [...this.setters.map(key => [key, null])]
    for (const [key, setup] of Object.entries(MOUNTED_PAIRS[this.type] || {})) keys.push([key, setup])
    for (const [key, setup] of keys) {
      const name = setup ? `${keyName(key)}[mounted]` : keyName(key)
      const first = (setup ? this.mountedValue(key, setup) : this.cloneValue(key)) ?? this.acceptedValue(key, setup)
      const second = this.secondValue(key, setup)
      if (!first) noValue.push(name)
      else if (!second) noSecond.push(name)
      const text = this.pairWrites(key, setup, first ?? (() => 1), second ?? first ?? (() => 1))
      if (text === null) fine.push(name)
      else this.line(`h ${name}: ${text}`)
    }
    this.line(`h each write and read reached its own node only: ${fine.join(' ') || '-'}`)
    if (noValue.length) this.line(`h no value accepted (each write throws, on both nodes): ${noValue.join(' ')}`)
    if (noSecond.length)
      this.line(`h no second value that reads otherwise (the first is written twice): ${noSecond.join(' ')}`)
    this.pairReads()
  }

  // the first value the proxy accepts for a key at all (a key whose every accepted value reads as the default)
  acceptedValue(key, setup) {
    for (const make of [...this.validOf(key), ...HOSTILE.map(([, make]) => make)]) {
      const node = this.withSetup(new this.Type(), setup)
      try {
        node.getProxy()[key] = make(this.fx)
        return make
      } catch {
        // (refused: the next)
      }
    }
    return null
  }

  // a key read through a kept proxy (or through the class, where the proxy has no getter for it), with what the getters
  // of a plain object it returns read (a script's material); no getProxy() call
  readKept(node, proxy, key) {
    const target = Reflect.getOwnPropertyDescriptor(proxy, key)?.get ? proxy : node
    // (the node is the case's, so that its automatic id reads as one)
    return this.withNode(node, () => {
      try {
        return this.deep(target[key])
      } catch (err) {
        return `read throws ${errorText(err)}`
      }
    })
  }

  // one write through a kept proxy: what it threw, the own fields it changed, the watched calls (no console: a
  // once-only warning is said by the first write only)
  pairWrite(node, proxy, key, make) {
    const value = make(this.fx)
    const current = this.begin(node)
    const before = this.snapshot(node)
    let text = 'runs'
    try {
      proxy[key] = value
    } catch (err) {
      text = `throws ${errorText(err)}`
    }
    const delta = this.delta(before, this.snapshot(node))
    if (delta.length) text += ` Δ{${delta.join(' ')}}`
    if (current.calls.length) text += ` calls[${current.calls.join(',')}]`
    this.end()
    return text
  }

  // the own fields of `node` that changed since `before` (another node's write must change none)
  untouched(node, before) {
    this.begin(node)
    const delta = this.delta(before, this.snapshot(node))
    this.end()
    return delta.length ? `Δ{${delta.join(' ')}}` : ''
  }

  // the pair of writes of row h for one key: null when each write and read reached its own node only, else what did not
  pairWrites(key, setup, first, second) {
    const fresh = () => {
      const node = this.withSetup(new this.Type(), setup)
      return [node, node.getProxy()]
    }
    // (what each write does, and reads, on a node of its own; all made before the pair, which is made last)
    const [x, px] = fresh()
    const alone1 = this.pairWrite(x, px, key, first)
    const read1 = this.readKept(x, px, key)
    const [y, py] = fresh()
    const alone2 = this.pairWrite(y, py, key, second)
    const read2 = this.readKept(y, py, key)
    const [z, pz] = fresh()
    const fallback = this.readKept(z, pz, key)
    const [a, pa] = fresh()
    const [b, pb] = fresh()
    const reads = () => [this.readKept(a, pa, key), this.readKept(b, pb, key)]
    const snap = node => this.withNode(node, () => this.snapshot(node))
    const bBefore = snap(b)
    const w1 = this.pairWrite(a, pa, key, first)
    const b1 = this.untouched(b, bBefore)
    const r1 = reads()
    a.getProxy()
    const r1again = reads()
    const aBefore = snap(a)
    const w2 = this.pairWrite(b, pb, key, second)
    const a2 = this.untouched(a, aBefore)
    const r2 = reads()
    b.getProxy()
    const r2again = reads()
    const want1 = [read1, fallback]
    const want2 = [read1, read2]
    const same = (got, want) => got[0] === want[0] && got[1] === want[1]
    const ok =
      w1 === alone1 &&
      !b1 &&
      same(r1, want1) &&
      same(r1again, want1) &&
      w2 === alone2 &&
      !a2 &&
      same(r2, want2) &&
      same(r2again, want2)
    if (ok) return null
    return (
      `through a: ${w1}${b1 ? `, b ${b1}` : ''}; read a ${r1[0]}, b ${r1[1]}; after a.getProxy() a ${r1again[0]}, ` +
      `b ${r1again[1]}; through b: ${w2}${a2 ? `, a ${a2}` : ''}; read a ${r2[0]}, b ${r2[1]}; after b.getProxy() ` +
      `a ${r2again[0]}, b ${r2again[1]} (alone: ${alone1} reads ${read1}; ${alone2} reads ${read2}; new ${fallback})`
    )
  }

  // the get-only keys, and those whose setter takes no value, read through the kept proxies of two nodes in distinct
  // states (the states of row i, the second one's values all otherwise), against each state on a node of its own
  pairReads() {
    const readOnly = this.getters.filter(key => !this.setters.includes(key) || !this.cloneValue(key))
    const restores = []
    const node = variant => {
      const n = new this.Type()
      const proxy = n.getProxy()
      restores.push(this.distinct(n, variant))
      return [n, proxy]
    }
    const fine = []
    const constant = []
    try {
      const [x, px] = node(0)
      const [y, py] = node(1)
      const alone = new Map(readOnly.map(key => [key, [this.readKept(x, px, key), this.readKept(y, py, key)]]))
      const [a, pa] = node(0)
      const [b, pb] = node(1)
      const rounds = [[], [], []]
      for (const key of readOnly) rounds[0].push([this.readKept(a, pa, key), this.readKept(b, pb, key)])
      a.getProxy()
      for (const key of readOnly) rounds[1].push([this.readKept(a, pa, key), this.readKept(b, pb, key)])
      b.getProxy()
      for (const key of readOnly) rounds[2].push([this.readKept(a, pa, key), this.readKept(b, pb, key)])
      readOnly.forEach((key, i) => {
        const want = alone.get(key)
        if (want[0] === want[1]) constant.push(keyName(key))
        const ok = rounds.every(([...round]) => round[i][0] === want[0] && round[i][1] === want[1])
        if (ok) fine.push(keyName(key))
        else {
          const got = rounds.map(round => `a ${round[i][0]}, b ${round[i][1]}`).join('; ')
          this.line(`h read ${keyName(key)}: ${got} (alone: a ${want[0]}, b ${want[1]})`)
        }
      })
    } finally {
      for (const restore of restores.reverse()) restore()
    }
    this.line(`h each read of a key no script sets reached its own node only: ${fine.join(' ') || '-'}`)
    if (constant.length) this.line(`h the same in both states (a constant): ${constant.join(' ')}`)
  }

  // i. every getter of the proxy (and the class's, where it reads otherwise) on a node whose backing values are
  // distinct: under a positioned parent (its matrix is not its matrixWorld), with two children, its own transform and
  // callbacks, and the type's computed state (an audio source playing, a video instance with its own playback fields,
  // ...). Values a getter reads that coincide with another get-only key's are listed
  rowI() {
    this.line('== i. every getter on a node whose backing values are distinct')
    const node = new this.Type()
    const proxy = node.getProxy()
    const restore = this.distinct(node, 0)
    const same = []
    const texts = new Map()
    this.objects = new Set()
    try {
      for (const key of this.getters) {
        this.begin(node)
        let text
        try {
          const value = proxy[key]
          if (value !== null && (typeof value === 'object' || typeof value === 'function')) this.objects.add(key)
          text = this.deep(value)
        } catch (err) {
          text = `read throws ${errorText(err)}`
        }
        const classGetter = this.classGetter(key)
        if (classGetter) {
          let classText
          try {
            classText = this.deep(Reflect.apply(classGetter, node, []))
          } catch (err) {
            classText = `read throws ${errorText(err)}`
          }
          if (classText !== text) text += ` (class: ${classText})`
        }
        text += this.consoleText(this.current.console)
        this.end()
        texts.set(key, text)
        this.block('i', key, [`i ${keyName(key)} = ${text}`], same)
      }
    } finally {
      restore()
    }
    if (same.length) this.line(`i as on node: ${same.join(' ')}`)
    // Two getters that read the same object, or two get-only getters (or ones no script can set) that read the same
    // value, could be reading each other's field: none may, but an alias listed in ALIASES (a constant is left out).
    // (A getter of a key a script sets is read back after its own set in row c.)
    const aliases = (ALIASES[this.type] || []).map(pair => [...pair].sort().join(' '))
    const compared = this.getters.filter(key => {
      if (CONSTANT_GETTERS.includes(key)) return false
      if (!this.setters.includes(key) || !this.cloneValue(key)) return true
      return this.objects.has(key)
    })
    const byText = new Map()
    for (const key of compared) {
      const text = texts.get(key)
      if (!byText.has(text)) byText.set(text, [])
      byText.get(text).push(keyName(key))
    }
    for (const [text, keys] of byText) {
      if (keys.length < 2) continue
      const alias = aliases.includes([...keys].sort().join(' '))
      this.line(`i the same value${alias ? ' (an alias)' : ''}: ${keys.join(' ')} = ${text}`)
      if (!alias) this.violations.push(`row i: ${keys.join(' ')} read the same value ${text}`)
    }
    this.aliasProbe(texts)
  }

  // each alias read (and, where it has a setter, written) with its target key redefined on the proxy: it must still
  // reach the node, not the proxy's own key
  aliasProbe(texts) {
    for (const [alias, target] of ALIASES[this.type] || []) {
      const node = new this.Type()
      const proxy = node.getProxy()
      const restore = this.distinct(node, 0)
      const desc = Reflect.getOwnPropertyDescriptor(proxy, target)
      try {
        Object.defineProperty(proxy, target, {
          get: () => 'the proxy',
          set: () => {},
          enumerable: true,
          configurable: true,
        })
        this.begin(node)
        let text
        try {
          text = this.deep(proxy[alias])
        } catch (err) {
          text = `read throws ${errorText(err)}`
        }
        let written = ''
        // (a value that reads otherwise than the state's own: the second one)
        const make = this.secondValue(alias, MOUNTED_PAIRS[this.type]?.[alias]) ?? this.cloneValue(alias)
        if (Reflect.getOwnPropertyDescriptor(proxy, alias).set && make) {
          try {
            proxy[alias] = make(this.fx)
            written = `; written: the node reads ${this.canon(node[target] ?? node.instance?.currentTime)}`
          } catch (err) {
            written = `; written: throws ${errorText(err)}`
          }
        }
        this.end()
        const want = texts.get(alias)?.replace(/ \(class: .*$/, '')
        this.line(`i alias ${keyName(alias)} with ${keyName(target)} redefined on the proxy: reads ${text}${written}`)
        if (text !== want)
          this.violations.push(`row i: alias ${alias} read ${text} with ${target} redefined, not ${want}`)
      } finally {
        Object.defineProperty(proxy, target, desc)
        restore()
      }
    }
  }

  // the getter a node class defines for a key, if any (a prototype accessor; an own field is no getter)
  classGetter(key) {
    for (let proto = this.Type.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, key)
      if (desc) return desc.get ?? null
    }
    return null
  }

  // the distinct state of row i (variant 0), or a second one whose every value is otherwise (variant 1, row h); returns
  // what puts back anything set outside the node (a PHYSX stand-in)
  distinct(node, variant) {
    const { Node } = this.m
    const v = variant
    const parent = new Node({ id: v ? 'parent-b' : 'parent', position: [10 + 100 * v, 20 + 100 * v, 30 + 100 * v] })
    node.id = v ? 'node-b' : 'node-i'
    node.position.set(1 + 100 * v, 2 + 100 * v, 3 + 100 * v)
    node.rotation.set(0.1 + 0.3 * v, 0.2 + 0.3 * v, 0.3 + 0.3 * v)
    node.scale.set(2 + v, 3 + v, 4 + v)
    parent.add(node)
    node.add(new Node({ id: v ? 'child-c' : 'child-a' }))
    node.add(new Node({ id: v ? 'child-d' : 'child-b' }))
    parent.updateTransform()
    node.updateTransform()
    node._active = !!v
    node._cursor = v ? 'grab' : 'pointer'
    node._onPointerEnter = v ? function enterB() {} : function enter() {}
    node._onPointerLeave = v ? function leaveB() {} : function leave() {}
    node._onPointerDown = v ? function downB() {} : function down() {}
    node._onPointerUp = v ? function upB() {} : function up() {}
    const liveRun = () => {
      const run = {}
      return { run, entity: { deadHook: run } }
    }
    // the type's own keys that read a function (a default callback) get one named after the key
    const proxy = node.getProxy()
    const isFunction = key => {
      try {
        return typeof proxy[key] === 'function'
      } catch {
        return false // (a getter that needs the state set below: audio's currentTime)
      }
    }
    for (const key of this.setters) {
      if (this.nodeKeys.has(key) || !isFunction(key)) continue
      const name = `${keyName(key)}${v ? 'B' : ''}`
      proxy[key] = { [name]: function () {} }[name]
    }
    switch (this.type) {
      case 'anchor':
        node.anchorId = v ? 'anchor-b' : 'anchor-i'
        break
      case 'audio':
        node.ctx = { world: { audio: { ctx: { currentTime: 10 } } } }
        // (the second: no source, so its time is its offset)
        node.source = v ? null : {}
        node.sourceStarted = !v
        node.startTime = 4
        node.offset = 2 + v
        break
      case 'avatar':
        node.instance = { height: 1.7 + v / 10, headToHeight: 0.3 }
        break
      case 'controller': {
        node.moveFlags = { isSet: flag => flag === 1 + v }
        const had = Object.hasOwn(globalThis, 'PHYSX')
        const was = globalThis.PHYSX
        globalThis.PHYSX = { PxControllerCollisionFlagEnum: { eCOLLISION_DOWN: 1, eCOLLISION_UP: 2 } }
        return () => {
          if (had) globalThis.PHYSX = was
          else delete globalThis.PHYSX
        }
      }
      case 'joint':
        // (apart from the node's own transform and from each other)
        node.offset0.set(11 + 100 * v, 12 + 100 * v, 13 + 100 * v)
        node.offset1.set(14 + 100 * v, 15 + 100 * v, 16 + 100 * v)
        node.rotation0.set(0.4 + 0.3 * v, 0, 0)
        node.rotation1.set(0, 0.5 + 0.3 * v, 0)
        node.axis.set(v, 0, 1 - v)
        break
      case 'mesh': {
        const facade = { opacity: v ? 0.25 : 0.5 }
        this.registry.set(facade, v ? 'facade#mesh-b' : 'facade#mesh')
        node.handle = { material: facade }
        node.ctx = liveRun()
        break
      }
      case 'rigidbody':
        node.actor = { isSleeping: () => !v }
        break
      case 'skinnedmesh':
        node.animNames = v ? ['jump'] : ['walk', 'run']
        break
      case 'video':
        node.instance = v
          ? { duration: 24, isPlaying: false, currentTime: 7 }
          : { duration: 12, isPlaying: true, currentTime: 3 }
        node._loading = !!v
        node.mesh = { material: { uniforms: { uOffset: { value: v ? { x: 0.5, y: 0.125 } : { x: 0.25, y: 0.75 } } } } }
        node.ctx = liveRun()
        break
    }
    return () => {}
  }

  // x. what the console said outside a case (the generator's own probing for sample values and its set-up), by row:
  // a once-only warning said there first is said nowhere else
  rowX() {
    if (!this.outside.length) return
    this.line("== x. the console outside the cases (the generator's own probing and set-up), by row")
    const rows = new Map()
    for (const [row, entry] of this.outside) {
      if (!rows.has(row)) rows.set(row, [])
      const list = rows.get(row)
      const last = list[list.length - 1]
      if (last && last.entry === entry) last.count++
      else list.push({ entry, count: 1 })
    }
    for (const [row, list] of rows) {
      this.line(`x ${row}: ${list.map(({ entry, count }) => (count > 1 ? `${entry}×${count}` : entry)).join(' ')}`)
    }
  }

  // nodes of this type as glbToNodes and the other host loaders make them
  hostNodes() {
    const { THREE, Nodes } = this.m
    const out = []
    const scene = new THREE.Group()
    const box = () => new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial()
    this.registry.set(material, 'material#glb')
    // (each with a transform of its own: a clone that lost one would read otherwise)
    let n = 0
    const object = (name, userData, base = new THREE.Object3D()) => {
      base.name = name
      base.userData = userData
      n++
      base.position.set(n, n + 1, n + 2)
      base.quaternion.set(0, 0.6, 0, 0.8)
      base.scale.set(n + 1, n + 1, n + 1)
      return base
    }
    scene.add(object('glbMesh', { castShadow: false }, new THREE.Mesh(box(), material)))
    const body = object('glbBody', { node: 'rigidbody', type: 'dynamic', mass: 2 })
    body.add(object('glbCollider', { node: 'collider', convex: true, layer: 'prop' }, new THREE.Mesh(box(), material)))
    scene.add(body)
    const lod = object('glbLod', { node: 'lod', scaleAware: false })
    lod.add(object('glbNear', { maxDistance: 10 }, new THREE.Mesh(box(), material)))
    scene.add(lod)
    scene.add(object('glbSnap', { node: 'snap' }))
    const skinned = object('glbSkinned', {})
    skinned.add(new THREE.SkinnedMesh(box(), material))
    scene.add(skinned)
    const animations = [new THREE.AnimationClip('idle', 1, [])]
    this.registry.set(animations, 'animations#glb')
    const root = this.m.glbToNodes({ scene, animations }, { network: { isServer: true } })
    root.traverse(n => {
      if (n.name === this.type) out.push([`glb ${n.id}`, n])
    })
    if (this.type === 'avatar') {
      const factory = { create() {}, applyStats() {} }
      const hooks = {}
      this.registry.set(factory, 'factory#host')
      this.registry.set(hooks, 'hooks#host')
      out.push(['host avatar (factory, hooks)', new Nodes.avatar({ factory, hooks })])
    }
    if (this.type === 'rigidbody') {
      const node = new Nodes.rigidbody({ type: 'dynamic' })
      node.setCenterOfMass(new THREE.Vector3(1, 2, 3))
      out.push(['host rigidbody (setCenterOfMass)', node])
    }
    if (this.type === 'lod') {
      const node = new Nodes.lod()
      node.insert(new Nodes.group({ id: 'near' }), 5)
      node.insert(new Nodes.group({ id: 'far' }), 50)
      out.push(['host lod (insert near 5, far 50)', node])
    }
    if (this.type === 'video') {
      const node = new Nodes.video()
      node.onLoad = function onLoad() {}
      out.push(['host video (onLoad)', node])
    }
    return out
  }

  // a node's own transform (a quaternion: a clone makes its rotation again from it, as the source did)
  transform(node, position, quaternion, scale) {
    node.position.set(...position)
    node.quaternion.set(...quaternion)
    node.scale.set(...scale)
  }

  // the fields copy() copies that no script setter reaches, away from a new node's
  hostFields(node) {
    if (this.type === 'joint') {
      node.offset0.set(1, 2, 3)
      node.quaternion0.set(0, 0.6, 0, 0.8)
      node.offset1.set(4, 5, 6)
      node.quaternion1.set(0.6, 0, 0, 0.8)
      node.axis.set(0, 0, 1)
    }
  }

  // clone() and clone(true) of `source`: each own field the same value, an equal copy, or different; the children of
  // a recursive clone. `alike`: also the fields still at a new node's value (a copy() that dropped one would not show)
  cloneLines(prefix, source, alike = false) {
    const plain = new this.Type()
    this.begin(source)
    const shown = []
    const same = []
    for (const [key, entry] of this.snapshot(source)) {
      if (key === 'id' || key === '_proxy') continue
      const text = this.fieldText(entry)
      this.current.node = plain
      const fallback = Object.hasOwn(plain, key) ? this.canon(plain[key]) : '<absent>'
      this.current.node = source
      if (text !== fallback) shown.push(`${keyName(key)}=${text}`)
      else same.push(keyName(key))
    }
    this.end()
    this.line(`${prefix} fields unlike a new node's: ${shown.join(' ') || '-'}`)
    if (alike) this.line(`${prefix} fields at a new node's value: ${same.join(' ') || '-'}`)
    for (const recursive of [false, true]) {
      let copy
      try {
        copy = source.clone(recursive)
      } catch (err) {
        this.line(`${prefix} clone(${recursive}) throws ${errorText(err)}`)
        continue
      }
      const sourceFields = this.withNode(source, () => this.snapshot(source))
      const copyFields = this.withNode(copy, () => this.snapshot(copy))
      const groups = { same: [], copy: [], differs: [], 'source only': [], 'clone only': [] }
      for (const [key, entry] of sourceFields) {
        const other = copyFields.get(key)
        const name = keyName(key)
        if (!other) groups['source only'].push(name)
        else if (entry.accessor || other.accessor)
          groups[entry.accessor && other.accessor ? 'same' : 'differs'].push(name)
        else if (Object.is(entry.value, other.value)) groups.same.push(name)
        else {
          const a = this.withNode(source, () => this.canon(entry.value))
          const b = this.withNode(copy, () => this.canon(other.value))
          if (a === b) groups.copy.push(name)
          else groups.differs.push(`${name}(${a} -> ${b})`)
        }
      }
      for (const key of copyFields.keys()) if (!sourceFields.has(key)) groups['clone only'].push(keyName(key))
      for (const [name, keys] of Object.entries(groups)) {
        if (keys.length) this.line(`${prefix} clone(${recursive}) ${name}: ${keys.join(' ')}`)
      }
      if (recursive) {
        const pairs = source.children.map((child, i) => {
          const twin = copy.children[i]
          const made = twin === child ? 'the same node' : twin ? `${twin.name}#${twin.id}` : 'none'
          return `${child.name}#${child.id} -> ${made}`
        })
        this.line(`${prefix} clone(true) children: ${pairs.join(', ') || '-'}`)
      }
    }
  }

  withNode(node, fn) {
    this.begin(node)
    try {
      return fn()
    } finally {
      this.end()
    }
  }

  text() {
    return this.lines.join('\n') + '\n'
  }
}

function rank(label) {
  const i = PREFERENCE.indexOf(label)
  return i === -1 ? PREFERENCE.length : i
}

// The console, from before the bundle is evaluated (code that keeps a console function at import gets this one): to the
// case being run; outside a case to row x; before the characterization exists (the evaluation, the fixtures) to row x
// as `setup`; once the cases are over to `late`
function captureConsole(sink, late) {
  const saved = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[level] = console[level]
    console[level] = (...args) => {
      const characterization = sink.characterization
      const text = args.map(arg =>
        typeof arg === 'string'
          ? JSON.stringify(arg)
          : characterization
            ? characterization.canon(arg)
            : `<${typeof arg}>`
      )
      const entry = `${level}:${text.join(',')}`
      if (!characterization) sink.early.push(entry)
      else if (characterization.current) characterization.current.console.push(entry)
      else if (characterization.settling) late.push(entry)
      else characterization.outside.push([characterization.row, entry])
    }
  }
  return () => Object.assign(console, saved)
}

// the text of one node type, from its own evaluation of the bundle at `url`; `reference` is the node type's blocks
// (null while generating the node type itself)
async function generateType(url, type, reference) {
  const late = []
  const sink = { characterization: null, early: [] }
  const restore = captureConsole(sink, late)
  let characterization
  try {
    const m = await import(`${url}?golden=${type}`)
    characterization = new Characterization(m, type, reference)
    characterization.outside.push(...sink.early.map(entry => ['setup', entry]))
    sink.characterization = characterization
    try {
      characterization.run()
    } catch (err) {
      // (a type that cannot be characterized, a constructor that throws: said where its text stops)
      characterization.end()
      characterization.line(`generation stopped: ${errorText(err)}`)
      characterization.violations.push(`generation stopped: ${errorText(err)}`)
    }
    // what a case started and a promise finished later
    characterization.settling = true
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    restore()
  }
  if (late.length) characterization.line(`late console: ${late.join(' ')}`)
  return { text: characterization.text(), violations: characterization.violations, blocks: characterization.blocks }
}

// the node types a bundle has: node, then the exports of src/core/nodes/index.js (the namespace orders them by name)
export async function nodeTypesIn(url) {
  const m = await import(`${url}?golden=types`)
  return ['node', ...Object.keys(m.Nodes)]
}

// the texts of `types` (default: all), each from its own evaluation of the bundle; the node type is always run first,
// since the others refer to it
export async function generateGolden(url, types = NODE_TYPES) {
  const node = await generateType(url, 'node', null)
  const out = new Map()
  for (const type of types) out.set(type, type === 'node' ? node : await generateType(url, type, node.blocks))
  return out
}

// the first block of lines where `actual` differs from `expected`: what the file has there, and what was generated
export function firstDifferences(expected, actual, shown = 10) {
  const a = expected.split('\n')
  const b = actual.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const removed = a.slice(start, endA + 1)
  const added = b.slice(start, endB + 1)
  const list = (lines, sign) => [
    ...lines.slice(0, shown).map(line => `${sign} ${line}`),
    ...(lines.length > shown ? [`${sign} … ${lines.length - shown} more`] : []),
  ]
  return [
    `from line ${start + 1}: ${removed.length} line(s) of the file, ${added.length} generated in their place`,
    ...list(removed, '-'),
    ...list(added, '+'),
  ].join('\n')
}

// UPDATE_GOLDEN=1 rewrites the golden files; a CI run (CI set) never does: the files are rewritten by hand and their
// diff read
export function updateMode(env) {
  if (env.UPDATE_GOLDEN !== '1') return false
  // (present at all, an empty value included)
  if (Object.prototype.hasOwnProperty.call(env, 'CI')) {
    throw new Error(
      'UPDATE_GOLDEN=1 is refused when CI is set: the golden files are rewritten by hand, and their diff read, never by a CI run'
    )
  }
  return true
}

// The tests of one shard: each type's text generated again and compared with its file (UPDATE_GOLDEN=1 writes the
// file instead), and row g's check that a clone reads as its source. Returns the bundle's url, for the caller's tests
// (null when the update is refused: nothing is generated, compared or written then).
export function goldenTests(types) {
  let update
  try {
    update = updateMode(process.env)
  } catch (err) {
    test('UPDATE_GOLDEN=1 in CI', () => {
      throw err
    })
    return { url: () => null }
  }
  let bundle
  let results
  let ms
  before(async () => {
    bundle = await bundleNodes()
    const started = performance.now()
    results = await generateGolden(bundle.url, types)
    ms = Math.round(performance.now() - started)
  })
  after(() => bundle?.destroy())
  for (const type of types) {
    test(`golden: ${type}`, t => {
      if (type === types[0]) t.diagnostic(`generated ${types.join(' ')} (and node) in ${ms} ms`)
      const { text } = results.get(type)
      const file = path.join(GOLDEN_DIR, `${type}.txt`)
      if (update) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true })
        fs.writeFileSync(file, text)
        return
      }
      const expected = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      if (text === expected) return
      assert.fail(
        `test/golden/nodes/${type}.txt differs from what the node classes do now ` +
          `(read the change, then rewrite with UPDATE_GOLDEN=1):\n${firstDifferences(expected, text)}`
      )
    })
  }
  // row g's check: a clone (recursive or not) of a node with one property set reads as its source, for every getter
  test(`a clone reads as its source for each proxy-settable property: ${types.join(' ')}`, () => {
    assert.deepEqual(
      types.flatMap(type => results.get(type).violations.map(v => `${type}.${v}`)),
      []
    )
  })
  return { url: () => bundle.url }
}
