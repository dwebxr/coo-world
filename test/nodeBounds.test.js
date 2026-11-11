// What a node keeps of a value that becomes a size (src/core/extras/boundedValue.js): the pixels of a UI's canvas,
// the particle pool, the texts measured on a canvas, the numbers handed to Web Audio and to the sky, a node's cursor,
// and the layer a model file asks for. No bound throws; the getter returns what was kept.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { bundleProbe, runProbe } from './lib/workerProbe.mjs'

let bundle
let m
before(async () => {
  bundle = await bundleProbe(`
    import './src/client/particles'
    export { createNode } from './src/core/extras/createNode'
    export { glbToNodes } from './src/core/extras/glbToNodes'
    export { cursorKeyword } from './src/core/extras/cursorKeyword.js'
    export { AUDIO_BOUNDS } from './src/core/extras/audioBounds.js'
    export { canvasScale, UI_CANVAS_MAX_SIDE, UI_CANVAS_MAX_PIXELS, UI_MAX_SIDE, UI_MAX_RES } from './src/core/nodes/UI'
    export { UITEXT_MAX_LENGTH, UITEXT_MAX_FONT_SIZE } from './src/core/nodes/UIText'
    export { PARTICLES_MAX, PARTICLES_MAX_RATE, PARTICLES_MAX_BURSTS } from './src/core/nodes/Particles'
    export { roundRect } from './src/core/extras/roundRect'
    export { watchLoad } from './src/core/nodes/Node'
    export { ClientAudio } from './src/core/systems/ClientAudio'
    export { NAMETAG_MAX_LENGTH } from './src/core/nodes/Nametag'
    export { ACTION_LABEL_MAX_LENGTH } from './src/core/nodes/Action'
    export { NODE_LAYERS } from './src/core/extras/Layers'
    export * as THREE from './src/core/extras/three'
  `)
  // the particle worker's module expects a worker's global
  const hadSelf = 'self' in globalThis
  const realSelf = globalThis.self
  globalThis.self = {}
  try {
    m = await import(bundle.url)
  } finally {
    if (hadSelf) globalThis.self = realSelf
    else delete globalThis.self
  }
})
after(() => bundle?.destroy())

// a script's handle of a new node
const handle = (type, data) => m.createNode(type, data).getProxy()

// [value given, value kept] for one numeric property
function keeps(type, name, pairs) {
  for (const [given, kept] of pairs) {
    const node = handle(type)
    node[name] = given
    assert.ok(
      Object.is(node[name], kept),
      `${type}.${name} = ${String(given)} keeps ${String(kept)}, got ${node[name]}`
    )
    // and the same through the options of app.create (the class's own setter)
    const made = m.createNode(type, { [name]: given })
    assert.ok(Object.is(made[name], kept), `${type} made with ${name}: ${String(given)} keeps ${String(kept)}`)
  }
}

test('ui: width, height, res and size are bounded; a value in range is kept as it is', () => {
  keeps('ui', 'width', [
    [300, 300],
    [0, 0],
    [33.3, 33.3],
    [NaN, 100],
    [-5, 0],
    [1e9, m.UI_MAX_SIDE],
    [Infinity, m.UI_MAX_SIDE],
    [-Infinity, 0],
  ])
  keeps('ui', 'height', [
    [200, 200],
    [NaN, 100],
    [-1, 0],
    [Infinity, m.UI_MAX_SIDE],
  ])
  keeps('ui', 'res', [
    [1, 1],
    [NaN, 2],
    [-1, 0],
    [1e9, m.UI_MAX_RES],
  ])
  keeps('ui', 'size', [
    [0.01, 0.01],
    [NaN, 0.01],
    [-1, 1e-6],
    [0, 1e-6],
    [Infinity, 1e6],
  ])
  // what is not a number is refused as before
  for (const bad of ['300', null, {}, new Number(3)]) {
    assert.throws(() => (handle('ui').width = bad), /width not a number/)
  }
})

test('ui: the canvas scale is 1 within the limits and brings anything larger inside them', () => {
  const { canvasScale, UI_CANVAS_MAX_SIDE: side, UI_CANVAS_MAX_PIXELS: pixels } = m
  for (const [w, h] of [
    [200, 200],
    [0, 0],
    [0, 4096],
    [3840, 2160],
    [4096, 2048],
    [2048, 4096],
    [2896, 2896],
  ]) {
    assert.equal(canvasScale(w, h), 1, `${w} x ${h} is drawn as it is`)
  }
  assert.equal(canvasScale(0, 5000), 4096 / 5000, 'a side over the limit is scaled even when the other is zero')
  assert.equal(canvasScale(8192, 100), 0.5)
  assert.equal(canvasScale(100, 8192), 0.5)
  assert.ok(Math.abs(canvasScale(4096, 4096) - Math.SQRT1_2) < 1e-12)
  // every size a UI can ask for: its sides times its res, up to the bounds of the setters
  const sizes = [1, 7, 100, 4095, 4096, 4097, 5000, 16384, 100000, m.UI_MAX_SIDE * m.UI_MAX_RES]
  for (const w of sizes) {
    for (const h of sizes) {
      const scale = canvasScale(w, h)
      assert.ok(scale > 0 && scale <= 1, `${w} x ${h}: scale ${scale}`)
      const cw = Math.floor(w * scale)
      const ch = Math.floor(h * scale)
      assert.ok(cw <= side && ch <= side, `${w} x ${h}: canvas ${cw} x ${ch} within ${side} a side`)
      assert.ok(cw * ch <= pixels, `${w} x ${h}: canvas ${cw} x ${ch} within ${pixels} pixels`)
      // and no smaller than it has to be: one of the limits is reached (to the pixel lost by rounding down)
      if (scale < 1) {
        const reached = cw >= side - 1 || ch >= side - 1 || (cw + 1) * (ch + 1) > pixels
        assert.ok(reached, `${w} x ${h}: canvas ${cw} x ${ch} is as large as a limit allows`)
      }
    }
  }
})

// A screen-space UI is built and drawn against a stand-in document: the canvas it makes, its CSS size and what the
// drawing context is told. The probe runs in a worker with a `window`, as the node only builds in a browser.
const buildUI = (args, check) =>
  runProbe(
    bundle,
    async ({ createNode }, { data, check, browser: _browser }) => {
      const canvases = []
      const calls = []
      const context = new Proxy(
        {},
        {
          get: (_target, name) =>
            name === 'measureText'
              ? () => ({ width: 0 })
              : (...values) => {
                  calls.push([name, ...values])
                },
          set: () => true,
        }
      )
      globalThis.document = {
        createElement(tag) {
          const canvas = {
            tag,
            style: {},
            getContext: () => (data.noContext ? null : context),
            addEventListener() {},
            removeEventListener() {},
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
          }
          canvases.push(canvas)
          return canvas
        },
      }
      const { noContext: _noContext, ...options } = data
      const ui = createNode('ui', { space: 'screen', backgroundColor: 'black', ...options })
      ui.ctx = {
        world: {
          network: { isServer: false },
          pointer: { ui: { prepend() {}, removeChild() {} }, setScreenHit() {} },
          setHot() {},
        },
        entity: null,
      }
      ui.setDirty = () => {}
      ui.mount()
      ui.draw()
      const canvas = canvases.at(-1)
      const result = {
        width: canvas.width,
        height: canvas.height,
        cssWidth: canvas.style.width,
        cssHeight: canvas.style.height,
        transform: calls.find(call => call[0] === 'setTransform')?.slice(1),
        clear: calls.find(call => call[0] === 'clearRect')?.slice(1),
        order: calls.map(call => call[0]),
      }
      new Function('result', 'assert', `(${check})(result, assert)`)(result, assert)
    },
    { browser: true, data: args, check: check.toString() }
  )

test('ui: a UI within the limits gets a canvas of its layout size, drawn unscaled', () =>
  buildUI({ width: 300, height: 200, res: 2 }, (r, assert) => {
    assert.deepEqual([r.width, r.height], [600, 400])
    assert.deepEqual([r.cssWidth, r.cssHeight], ['300px', '200px'])
    assert.deepEqual(r.transform, [1, 0, 0, 1, 0, 0])
    assert.deepEqual(r.clear, [0, 0, 600, 400])
    assert.ok(
      r.order.indexOf('setTransform') < r.order.indexOf('clearRect'),
      'the scale is set before anything is drawn'
    )
  }))

test('ui: an oversized UI keeps its layout and CSS size; its canvas is within the limits and the picture is scaled', () =>
  buildUI({ width: 10000, height: 5000, res: 16 }, (r, assert) => {
    assert.ok(r.width <= 4096 && r.height <= 4096, `canvas ${r.width} x ${r.height}`)
    assert.ok(r.width * r.height <= 8388608, `canvas ${r.width} x ${r.height}`)
    assert.ok(r.width >= 4000, 'as large as the limits allow')
    assert.deepEqual([r.cssWidth, r.cssHeight], ['10000px', '5000px'], 'the page still gives it its own size')
    const scale = r.transform[0]
    assert.ok(scale > 0 && scale < 1)
    assert.deepEqual(r.transform, [scale, 0, 0, scale, 0, 0])
    assert.ok(Math.abs(scale - r.width / 160000) < 1e-4, 'the scale is the canvas over the layout')
    assert.deepEqual(r.clear, [0, 0, 160000, 80000], 'drawing stays in layout units')
  }))

test('ui: sizes at their bounds still build (the largest UI a script can ask for)', () =>
  buildUI({ width: Infinity, height: Infinity, res: Infinity }, (r, assert) => {
    assert.ok(r.width <= 4096 && r.height <= 4096 && r.width * r.height <= 8388608, `canvas ${r.width} x ${r.height}`)
    assert.ok(r.width > 0 && r.height > 0)
  }))

test('ui: a canvas the browser gives no context for leaves the UI blank instead of throwing in draw', () =>
  buildUI({ width: 300, height: 200, noContext: true }, (r, assert) => {
    assert.deepEqual([r.width, r.height], [600, 400])
    assert.deepEqual(r.order, [], 'nothing was drawn')
  }))

test('uitext, nametag, action: texts are cut to their limits; the font size is bounded', () => {
  const long = 'x'.repeat(100000)
  const text = handle('uitext')
  text.value = long
  assert.equal(text.value.length, m.UITEXT_MAX_LENGTH)
  text.value = 'short'
  assert.equal(text.value, 'short')
  text.value = 12
  assert.equal(text.value, '12')
  assert.equal(m.createNode('uitext', { value: long }).value.length, m.UITEXT_MAX_LENGTH)
  keeps('uitext', 'fontSize', [
    [24, 24],
    [NaN, 16],
    [-1, 0],
    [1e9, m.UITEXT_MAX_FONT_SIZE],
  ])

  const tag = handle('nametag')
  tag.label = long
  assert.equal(tag.label.length, m.NAMETAG_MAX_LENGTH)
  tag.label = 'Alice'
  assert.equal(tag.label, 'Alice')

  const action = handle('action')
  action.label = long
  assert.equal(action.label.length, m.ACTION_LABEL_MAX_LENGTH)
  action.label = 'Open'
  assert.equal(action.label, 'Open')
  assert.equal(m.createNode('action', { label: long }).label.length, m.ACTION_LABEL_MAX_LENGTH)
})

test('particles: max, rate and bursts are bounded', () => {
  keeps('particles', 'max', [
    [1000, 1000],
    [10.7, 10],
    [0, 0],
    [NaN, 1000],
    [-1, 0],
    [1e9, m.PARTICLES_MAX],
    [Infinity, m.PARTICLES_MAX],
  ])
  keeps('particles', 'rate', [
    [10, 10],
    [0.5, 0.5],
    [NaN, 10],
    [-1, 0],
    [Infinity, m.PARTICLES_MAX_RATE],
  ])
  keeps('particles', 'duration', [
    [5, 5],
    [NaN, 5],
    [0, 0.01],
    [-1, 0.01],
    [Infinity, 1e6],
  ])
  keeps('particles', 'timescale', [
    [1, 1],
    [0, 0],
    [NaN, 1],
    [-1, 0],
    [1e9, 100],
  ])
  const node = handle('particles')
  node.bursts = [
    { time: 0, count: 10 },
    { time: NaN, count: 1e9 },
    { time: -1, count: 2.9 },
    { time: Infinity, count: NaN },
  ]
  assert.deepEqual(
    node.bursts.map(burst => [burst.time, burst.count]),
    [
      [0, 10],
      [0, m.PARTICLES_MAX],
      [0, 2],
      [1e6, 0],
    ]
  )
  assert.ok(Object.isFrozen(node.bursts) && node.bursts.every(Object.isFrozen))
  node.bursts = Array.from({ length: 1000 }, (_, i) => ({ time: i, count: 1 }))
  assert.equal(node.bursts.length, m.PARTICLES_MAX_BURSTS)
  assert.equal(node.bursts.at(-1).time, m.PARTICLES_MAX_BURSTS - 1, 'the first entries are the ones kept')
  // an entry past the limit is not read at all
  let read = 0
  const many = Array.from({ length: 100 }, () => ({
    get time() {
      read++
      return 0
    },
    count: 1,
  }))
  node.bursts = many
  assert.equal(read, m.PARTICLES_MAX_BURSTS)
  // what is not a list of numbers is refused as before
  assert.throws(() => (node.bursts = [{ time: '0', count: 1 }]), /bursts invalid/)
  assert.throws(() => (node.bursts = 'none'), /bursts invalid/)
  assert.throws(() => (node.max = '10'), /max not a number/)
})

// the particle worker itself, with a config as the node's getConfig() gives it
const emitterConfig = {
  op: 'create',
  id: 'probe',
  emitting: true,
  rate: 0,
  rateOverDistance: 0,
  bursts: [],
  duration: 100,
  loop: true,
  max: 8,
  timescale: 1,
  life: '5',
  speed: '0',
  size: '1',
  rotate: '0',
  color: 'white',
  alpha: '1',
  emissive: '1',
  shape: ['point'],
  direction: 0,
  space: 'world',
  blending: 'additive',
}

// runs one emitter: creates it, then one update per delta; returns the particle count after each
const runEmitter = (config, deltas, expected) =>
  runProbe(
    bundle,
    ({ THREE }, { config, deltas, expected }) => {
      let output
      self.postMessage = msg => {
        output = msg
      }
      self.onmessage({ data: config })
      const max = Math.max(1, config.max)
      const counts = []
      for (const delta of deltas) {
        self.onmessage({
          data: {
            op: 'update',
            emitterId: 'probe',
            delta,
            camPosition: [0, 0, 0],
            matrixWorld: new THREE.Matrix4().toArray(),
            aPosition: new Float32Array(max * 3),
            aRotation: new Float32Array(max),
            aDirection: new Float32Array(max * 3),
            aSize: new Float32Array(max),
            aColor: new Float32Array(max * 3),
            aAlpha: new Float32Array(max),
            aEmissive: new Float32Array(max),
            aUV: new Float32Array(max * 4),
          },
        })
        assert.equal(output.op, 'update')
        counts.push(output.n)
      }
      assert.deepEqual(counts, expected)
    },
    { config, deltas, expected }
  )

test('particle worker: a step starts as many particles as are free, in pool order, and no more', () =>
  // 3 a second: 1.5 by the first step (1 started), 3 by the second (2 more), then the pool of 8 fills and stays full
  runEmitter({ ...emitterConfig, rate: 3 }, [0.5, 0.5, 1, 1, 1], [1, 3, 6, 8, 8]))

test('particle worker: bursts start their counts, up to the pool', () =>
  runEmitter(
    {
      ...emitterConfig,
      bursts: [
        { time: 0, count: 3 },
        { time: 1, count: 100 },
      ],
    },
    [0.1, 1],
    [3, 8]
  ))

test('particle worker: a rate without end and particles with no life cannot hold a step (the loop is the pool long)', () =>
  // each particle is free again the moment it is started; the step must still end
  runEmitter({ ...emitterConfig, rate: Infinity, life: '0' }, [0.1, 0.1], [0, 0]))

test('particle worker: a burst without end and particles with no life cannot hold a step', () =>
  runEmitter({ ...emitterConfig, life: '0', bursts: [{ time: 0, count: Infinity }] }, [0.1], [0]))

// The work of one step is counted through the emitter's own curve: `life` is read once per start.
const countStarts = (config, deltas, limit) =>
  runProbe(
    bundle,
    ({ THREE }, { config, deltas, limit }) => {
      self.postMessage = () => {}
      // a life of '0' parses to a constant; count the starts through Math.random, which shape() calls per start
      let starts = 0
      const random = Math.random
      Math.random = () => {
        starts++
        return random()
      }
      self.onmessage({ data: config })
      const max = config.max
      const perStep = []
      for (const delta of deltas) {
        starts = 0
        self.onmessage({
          data: {
            op: 'update',
            emitterId: 'probe',
            delta,
            camPosition: [0, 0, 0],
            matrixWorld: new THREE.Matrix4().toArray(),
            aPosition: new Float32Array(max * 3),
            aRotation: new Float32Array(max),
            aDirection: new Float32Array(max * 3),
            aSize: new Float32Array(max),
            aColor: new Float32Array(max * 3),
            aAlpha: new Float32Array(max),
            aEmissive: new Float32Array(max),
            aUV: new Float32Array(max * 4),
          },
        })
        perStep.push(starts)
      }
      Math.random = random
      assert.ok(perStep[0] > 0, `the probe sees starts (${perStep})`)
      for (const count of perStep) assert.ok(count <= limit, `starts in a step: ${perStep} (limit ${limit})`)
    },
    { config, deltas, limit }
  )

test('particle worker: one step starts no more than the pool holds, over its rate and all its bursts together', () =>
  // 64 bursts of the whole pool each, a rate without end and particles with no life, in a cycle that restarts its
  // bursts every step: each step may start 8 (the pool), not 8 x 65. shape 'sphere' draws random numbers per start
  // (at most 6 here: 3 for the shape's point and its retry, and 3 for the direction spread)
  countStarts(
    {
      ...emitterConfig,
      rate: Infinity,
      life: '0',
      duration: 0.01,
      shape: ['sphere', 1, 1],
      direction: 1,
      bursts: Array.from({ length: 64 }, () => ({ time: 0, count: 8 })),
    },
    [0.1, 0.1, 0.1],
    8 * 12
  ))

test('particle worker: the step budget starts again with every step', () =>
  // two a second into a pool of four, each living a second and a half: every step starts two (six in all by the
  // third step, more than the pool), reusing the ones that died
  runEmitter({ ...emitterConfig, max: 4, rate: 2, life: '1.5' }, [1, 1, 1, 1], [2, 2, 2, 2]))

test('particle worker: only the first 64 points of an over-life curve count', () =>
  runProbe(
    bundle,
    ({ THREE }, { config }) => {
      let output
      self.postMessage = msg => {
        output = msg
      }
      self.onmessage({ data: config })
      const max = config.max
      self.onmessage({
        data: {
          op: 'update',
          emitterId: 'probe',
          delta: 0.9,
          camPosition: [0, 0, 0],
          matrixWorld: new THREE.Matrix4().toArray(),
          aPosition: new Float32Array(max * 3),
          aRotation: new Float32Array(max),
          aDirection: new Float32Array(max * 3),
          aSize: new Float32Array(max),
          aColor: new Float32Array(max * 3),
          aAlpha: new Float32Array(max),
          aEmissive: new Float32Array(max),
          aUV: new Float32Array(max * 4),
        },
      })
      assert.ok(output.n > 0)
      // 90% through its life: past the 64th point (at 63%), which is the last one read; the 65th and later would
      // make it a hundred times as large
      assert.equal(output.aSize[0], 1)
    },
    {
      config: {
        ...emitterConfig,
        rate: 10,
        life: '1',
        size: '1',
        sizeOverLife: Array.from({ length: 100 }, (_, i) => `${i / 100},${i < 64 ? 1 : 100}`).join('|'),
      },
    }
  ))

test('particle worker: an over-life curve is read up to 64 points', () =>
  // 100,000 points: the emitter is made and steps (each particle walks the curve every step)
  runEmitter(
    {
      ...emitterConfig,
      rate: 10,
      sizeOverLife: Array.from({ length: 100000 }, (_, i) => `${i / 100000},1`).join('|'),
      colorOverLife: Array.from({ length: 100000 }, (_, i) => `${i / 100000},white`).join('|'),
    },
    [0.5, 0.5],
    [5, 8]
  ))

test('particle worker: a spritesheet of a billion rows and columns is bounded to 256 each', () =>
  runEmitter({ ...emitterConfig, rate: 10, spritesheet: [1e9, 1e9, 30, true] }, [0.5, 0.5], [5, 8]))

test('particle worker: spritesheet rows and columns are read by the number rule (a string digit counts, an object does not)', () =>
  runEmitter({ ...emitterConfig, rate: 10, spritesheet: ['2', null, 30, false] }, [0.5], [5]))

test('audio and video: the numbers given to Web Audio stay inside the ranges it accepts', () => {
  // a panner as strict as the browser's: it throws for what Web Audio refuses
  const strictPanner = () => {
    const values = {}
    const rule = (name, ok) => ({
      get: () => values[name],
      set(value) {
        if (!Number.isFinite(value)) throw new TypeError(`${name}: non-finite`)
        if (!ok(value)) throw new RangeError(`${name}: ${value}`)
        values[name] = value
      },
    })
    return Object.defineProperties(
      {},
      {
        refDistance: rule('refDistance', v => v >= 0),
        maxDistance: rule('maxDistance', v => v > 0),
        rolloffFactor: rule('rolloffFactor', v => v >= 0),
        coneInnerAngle: rule('coneInnerAngle', () => true),
        coneOuterAngle: rule('coneOuterAngle', () => true),
        coneOuterGain: rule('coneOuterGain', v => v >= 0 && v <= 1),
      }
    )
  }
  const gain = () => {
    let value = 1
    return {
      gain: {
        get value() {
          return value
        },
        set value(next) {
          if (!Number.isFinite(next)) throw new TypeError('gain: non-finite')
          value = next
        },
      },
    }
  }
  const hostile = [NaN, Infinity, -Infinity, -1, 0, 1e300, 0.5, 720]
  for (const type of ['audio', 'video']) {
    const node = m.createNode(type)
    // (the audio node holds its panner as pannerNode and its gain as gainNode, the video node as panner and gain)
    const panner = strictPanner()
    if (type === 'audio') Object.assign(node, { pannerNode: panner, gainNode: gain() })
    else Object.assign(node, { panner, gain: gain() })
    const proxy = node.getProxy()
    for (const name of Object.keys(m.AUDIO_BOUNDS)) {
      const [min, max] = m.AUDIO_BOUNDS[name]
      for (const value of hostile) {
        proxy[name] = value // a playing node: the value goes straight to the panner or the gain, which must accept it
        assert.ok(proxy[name] >= min && proxy[name] <= max, `${type}.${name} = ${value} kept ${proxy[name]}`)
        if (name !== 'volume') assert.equal(panner[name], proxy[name], `${type}.${name} reaches the panner`)
      }
      proxy[name] = NaN
      assert.equal(proxy[name], m.createNode(type)[name], `${type}.${name}: a NaN is the default`)
    }
  }
  keeps('audio', 'coneOuterGain', [
    [0.25, 0.25],
    [5, 1],
    [-1, 0],
  ])
  keeps('audio', 'maxDistance', [
    [40, 40],
    [0, 0.0001],
    [-3, 0.0001],
  ])
})

test('sky: a NaN counts as not set, the rest is bounded; null stays null', () => {
  for (const name of ['rotationY', 'sunIntensity', 'fogNear', 'fogFar']) {
    const sky = handle('sky')
    assert.equal(sky[name], null)
    sky[name] = 3
    assert.equal(sky[name], 3)
    sky[name] = NaN
    assert.equal(sky[name], null)
    sky[name] = Infinity
    assert.equal(sky[name], 1e9)
    sky[name] = -Infinity
    assert.equal(sky[name], name === 'rotationY' ? -1e9 : 0)
    sky[name] = null
    assert.equal(sky[name], null)
    assert.throws(() => (sky[name] = '3'), /not a number/)
  }
})

test('image and video: a screen side is finite and not negative, or not set', () => {
  for (const type of ['image', 'video']) {
    for (const name of ['width', 'height']) {
      const node = handle(type)
      node[name] = 2.5
      assert.equal(node[name], 2.5)
      node[name] = NaN
      assert.equal(node[name], null, 'a NaN counts as not set')
      node[name] = -1
      assert.equal(node[name], 0)
      node[name] = Infinity
      assert.equal(node[name], 1e6)
      node[name] = null
      assert.equal(node[name], null)
    }
  }
  keeps('video', 'aspect', [
    [4 / 3, 4 / 3],
    [NaN, 16 / 9],
    [0, 0.001],
    [-2, 0.001],
    [Infinity, 1000],
  ])
})

test('cursor: a CSS cursor keyword is kept; of an image cursor only its closing keyword; nothing else, and no throw', () => {
  const { cursorKeyword } = m
  assert.equal(cursorKeyword('pointer'), 'pointer')
  assert.equal(cursorKeyword(' Grab '), 'grab')
  assert.equal(cursorKeyword('NOT-ALLOWED'), 'not-allowed')
  // an image cursor's list ends in a keyword (CSS requires one): that keyword is what is used
  assert.equal(cursorKeyword('url(https://example.test/c.png), auto'), 'auto')
  assert.equal(cursorKeyword('url("https://example.test/c.png") 4 4, url(d.png), Pointer'), 'pointer')
  for (const value of [
    'url(https://example.test/c.png)',
    'url("https://example.test/a,pointer")',
    'url(a.png), pointer, url(b.png)',
    'image-set(url(a.png) 1x)',
    'pointer;background:red',
    'pointer url(x)',
    'var(--x)',
    'inherit',
    '',
    ',',
    'hand',
    7,
    null,
    undefined,
    {},
  ]) {
    assert.equal(cursorKeyword(value), null, String(value))
  }
  // whatever is kept is a bare keyword: no value can carry a url() to the page's style
  for (const value of ['url(x), auto', 'URL(x) , GRAB', 'pointer', 'url(a), url(b), crosshair']) {
    assert.match(cursorKeyword(value), /^[a-z-]+$/)
  }

  const warnings = []
  const realWarn = console.warn
  console.warn = (...line) => warnings.push(line.join(' '))
  try {
    const node = handle('group')
    assert.equal(node.cursor, undefined)
    node.cursor = 'pointer'
    assert.equal(node.cursor, 'pointer')
    node.cursor = ' Crosshair'
    assert.equal(node.cursor, 'crosshair')
    assert.equal(warnings.length, 0, 'a keyword is not remarked on')
    node.cursor = 'url(https://example.test/c.png), grab'
    assert.equal(node.cursor, 'grab')
    assert.equal(warnings.length, 1, 'an image cursor is said')
    node.cursor = 'url(https://example.test/c.png)'
    assert.equal(node.cursor, null)
    node.cursor = 'hand'
    assert.equal(node.cursor, null)
    assert.equal(warnings.length, 1, 'said once')
    assert.match(warnings[0], /cursor/)
    node.cursor = null
    assert.equal(node.cursor, null)
    // the refusals there were stay
    assert.throws(() => (node.cursor = 'x'.repeat(129)), /at most 128/)
    assert.throws(() => (node.cursor = 7), /cursor must be a string/)
    // and a node made with a cursor (the class's constructor) is held to the same rule
    assert.equal(m.createNode('group', { cursor: 'url(x)' }).cursor, null)
    assert.equal(m.createNode('group', { cursor: 'url(x), wait' }).cursor, 'wait')
    assert.equal(m.createNode('group', { cursor: 'grab' }).cursor, 'grab')
  } finally {
    console.warn = realWarn
  }
})

test("layer: a model file gets the layers a script may set; the players layer stays the engine's own", () => {
  assert.deepEqual([...m.NODE_LAYERS], ['environment', 'prop', 'tool'])
  for (const type of ['collider', 'prim', 'controller']) {
    for (const layer of m.NODE_LAYERS) {
      const node = handle(type)
      node.layer = layer
      assert.equal(node.layer, layer)
    }
    // a script's handle refuses the players' layer, as before
    assert.throws(() => (handle(type).layer = 'player'), /layer/, `${type}: through the handle`)
  }
  // the engine itself makes the other players' capsules there (PlayerRemote): the class must keep taking it
  assert.equal(m.createNode('collider', { type: 'geometry', convex: true, layer: 'player' }).layer, 'player')

  // a model whose collider meshes carry a custom `layer` property
  const { THREE } = m
  const mesh = layer => {
    const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    object.name = `c-${layer}`
    object.userData = { node: 'collider', layer }
    return object
  }
  const body = new THREE.Group()
  body.name = 'body'
  body.userData = { node: 'rigidbody' }
  for (const layer of ['player', 'prop', 'tool', 'nonsense', 7, undefined]) body.add(mesh(layer))
  const scene = new THREE.Group()
  scene.add(body)
  const root = m.glbToNodes({ scene }, {})
  const layers = {}
  root.traverse(node => {
    if (node.name === 'collider') layers[node.id] = node.layer
  })
  assert.deepEqual(layers, {
    'c-player': 'environment',
    'c-prop': 'prop',
    'c-tool': 'tool',
    'c-nonsense': 'environment',
    'c-7': 'environment',
    'c-undefined': 'environment',
  })
})

test('roundRect: a box without a size adds nothing, and the radius is never negative', () => {
  const path = (...box) => {
    const calls = []
    const ctx = {
      rect: (...a) => calls.push(['rect', ...a]),
      moveTo: () => calls.push(['moveTo']),
      lineTo: () => calls.push(['lineTo']),
      closePath: () => calls.push(['closePath']),
      // as a canvas: a negative radius is an IndexSizeError
      arc(x, y, radius) {
        if (radius < 0) throw new RangeError('IndexSizeError')
        calls.push(['arc', radius])
      },
    }
    m.roundRect(ctx, ...box)
    return calls
  }
  const radii = calls => calls.filter(call => call[0] === 'arc').map(call => call[1])
  assert.deepEqual(radii(path(0, 0, 10, 10, 3)), [3, 3, 3, 3])
  assert.deepEqual(radii(path(0, 0, 10, 4, 5)), [2, 2, 2, 2], 'no more than half the shorter side')
  assert.deepEqual(path(0, 0, 10, 10, 0), [['rect', 0, 0, 10, 10]])
  assert.deepEqual(path(0, 0, 10, 10, -5), [['rect', 0, 0, 10, 10]], 'a negative radius is a plain box')
  assert.deepEqual(path(0, 0, 10, 10, NaN), [['rect', 0, 0, 10, 10]])
  // a border wider than its box, a health bar below zero: nothing, where arc() threw
  assert.deepEqual(path(0, 0, -4, 10, 2), [])
  assert.deepEqual(path(0, 0, 10, -4, 2), [])
  assert.deepEqual(path(0, 0, 0, 10, 2), [])
  assert.deepEqual(path(0, 0, NaN, 10, 2), [])
})

test('a load that fails in an async mount or build is reported, not left as an unhandled rejection', async () => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const warnings = []
  const realWarn = console.warn
  console.warn = (...line) => warnings.push(line.join(' '))
  try {
    m.watchLoad({ name: 'probe' }, Promise.reject(new Error('gone')))
    m.watchLoad({ name: 'probe' }, undefined) // a mount that is not async
    m.watchLoad({ name: 'probe' }, Promise.resolve())

    // the real nodes, with a loader that refuses: an image (mount -> build), a UI image (loadImage)
    const world = {
      network: { isServer: false },
      resolveURL: url => url,
      loader: { get: () => null, load: () => Promise.reject(new Error('asset refused')) },
    }
    const image = m.createNode('image', { src: 'asset://missing.png' })
    image.ctx = { world }
    image.mount()
    image.needsRebuild = true
    image.commit(false)
    const uiImage = m.createNode('uiimage', { src: 'asset://missing.png' })
    uiImage.ctx = { world }
    uiImage.mounted = true
    uiImage.canMount = () => true
    uiImage.src = 'asset://other.png' // the setter starts a load

    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [])
    assert.equal(warnings.filter(line => line.includes('[probe] not loaded: gone')).length, 1)
    assert.equal(warnings.filter(line => line.includes('[image] not loaded: asset refused')).length, 2)
    assert.equal(warnings.filter(line => line.includes('[uiimage] not loaded: asset refused')).length, 1)
  } finally {
    console.warn = realWarn
    process.off('unhandledRejection', onUnhandled)
  }
})

test('audio: a start offset is finite; a panner is not given a position that is not finite', () => {
  const audio = m.createNode('audio')
  audio.ctx = { world: { audio: null } }
  for (const [given, kept] of [
    [2.5, 2.5],
    [NaN, 0],
    [-1, 0],
    [Infinity, 1e9],
  ]) {
    audio.currentTime = given
    assert.equal(audio.offset, kept, `currentTime = ${given}`)
  }

  // a panner as strict as the browser's, on a node whose transform holds a NaN
  const ramps = []
  const param = {
    linearRampToValueAtTime: value => (Number.isFinite(value) ? ramps.push(value) : assert.fail('NaN ramp')),
  }
  const strict = () => ({
    positionX: param,
    positionY: param,
    positionZ: param,
    orientationX: param,
    orientationY: param,
    orientationZ: param,
  })
  for (const [type, field] of [
    ['audio', 'pannerNode'],
    ['video', 'panner'],
  ]) {
    const node = m.createNode(type)
    node.ctx = { world: { audio: { ctx: { currentTime: 0 }, lastDelta: 0 } } }
    node[field] = strict()
    ramps.length = 0
    node.updatePannerPosition()
    assert.equal(ramps.length, 6, `${type}: a finite position is written`)
    node.matrixWorld.elements[12] = NaN
    node.updatePannerPosition()
    assert.equal(ramps.length, 6, `${type}: a NaN position is not`)
  }
})

test('audio: one queued sound that throws at unlock does not keep the others from starting', async () => {
  const realDocument = globalThis.document
  const realLog = console.log
  const realError = console.error
  const listeners = {}
  const errors = []
  globalThis.document = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: type => delete listeners[type],
    createElement: () => ({ play: async () => {}, pause() {}, remove() {} }),
  }
  console.log = () => {}
  console.error = (...line) => errors.push(line.join(' '))
  try {
    const started = []
    const audio = {
      ctx: { state: 'running', resume: async () => {} },
      unlocked: false,
      queue: [
        () => started.push('first'),
        () => {
          throw new TypeError('start: offset is not finite')
        },
        () => started.push('last'),
      ],
    }
    m.ClientAudio.prototype.setupUnlockListener.call(audio)
    await listeners.click()
    assert.equal(audio.unlocked, true)
    assert.deepEqual(started.sort(), ['first', 'last'])
    assert.equal(audio.queue.length, 0)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /queued sound/)
  } finally {
    globalThis.document = realDocument
    console.log = realLog
    console.error = realError
  }
})
