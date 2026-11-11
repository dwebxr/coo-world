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
    export {
      PARTICLES_MAX,
      PARTICLES_MAX_RATE,
      PARTICLES_MAX_BURSTS,
      PARTICLES_MAX_START_LENGTH,
      PARTICLES_MAX_CURVE_LENGTH,
    } from './src/core/nodes/Particles'
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
// drawing context is told. The probe runs in a worker with a `window`, as the node only builds in a browser. With
// `text`, the UI holds a text child of that value (which measures itself on a canvas of its own); `noContext` gives no
// canvas a drawing context, `noMeasureContext` none but the UI's own (the first canvas made).
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
            getContext: () =>
              data.noContext || (data.noMeasureContext && canvases.indexOf(canvas) > 0) ? null : context,
            addEventListener() {},
            removeEventListener() {},
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
          }
          canvases.push(canvas)
          return canvas
        },
      }
      const { noContext: _noContext, noMeasureContext: _noMeasureContext, text: value, ...options } = data
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
      const text = value === undefined ? null : createNode('uitext', { value, fontSize: 20 })
      if (text) ui.add(text)
      ui.mount()
      if (text) {
        text.ctx = ui.ctx
        text.mounted = true
        text.mount()
      }
      ui.draw()
      const canvas = canvases[0]
      const result = {
        width: canvas.width,
        height: canvas.height,
        cssWidth: canvas.style.width,
        cssHeight: canvas.style.height,
        transform: calls.find(call => call[0] === 'setTransform')?.slice(1),
        clear: calls.find(call => call[0] === 'clearRect')?.slice(1),
        order: calls.map(call => call[0]),
        canvases: canvases.length,
        textBox: text?.box ?? null,
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

test('ui: with a text child and no context anywhere, the UI stays blank and lays nothing out', () =>
  // the layout measures the text on a canvas of its own, which gets no context either: the UI's check comes first
  buildUI({ width: 300, height: 200, noContext: true, text: 'hello there' }, (r, assert) => {
    assert.deepEqual(r.order, [], 'nothing was drawn')
    assert.equal(r.canvases, 1, 'the text was not measured (no canvas was made for it)')
    assert.equal(r.textBox, null)
  }))

test('ui: a text whose measuring canvas gets no context takes no room, and the UI still draws', () =>
  buildUI({ width: 300, height: 200, noMeasureContext: true, text: 'hello there' }, (r, assert) => {
    assert.equal(r.canvases, 2, 'the text asked for its measuring canvas')
    assert.ok(r.order.includes('clearRect') && r.order.includes('fill'), `the UI was drawn: ${r.order}`)
    assert.ok(r.textBox, 'the text was laid out and drawn')
    assert.equal(r.textBox.height, 0, 'measured as nothing')
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

test('particles: start values and over-life curves are cut to their limits; every documented form is kept', () => {
  const starts = ['life', 'speed', 'size', 'rotate', 'color', 'alpha', 'emissive']
  const curves = ['sizeOverLife', 'rotateOverLife', 'colorOverLife', 'alphaOverLife', 'emissiveOverLife']
  // the forms of docs/scripting/nodes/types/Particles.md, and a curve of 64 points of the longest numbers JavaScript
  // prints (the worker reads 64)
  const documented = ['1', '1-5', '1~5', 'white', '#ff0000', 'red~blue', '0.1~0.30000000000000004']
  const longest = Array.from({ length: 64 }, () => '-0.0000012512313393425237,-0.0000012512313393425237').join('|')
  const curveForms = ['0,1|0.5,2|1,1', '0,red|1,#0000ff', longest]
  for (const name of starts) {
    const node = handle('particles')
    for (const value of documented) {
      node[name] = value
      assert.equal(node[name], value, `${name} = '${value}' is kept`)
    }
    node[name] = '0-1' + '-1'.repeat(100000)
    assert.equal(node[name].length, m.PARTICLES_MAX_START_LENGTH, `${name}: a long text is cut`)
    assert.equal(m.createNode('particles', { [name]: 'x'.repeat(1000) })[name].length, m.PARTICLES_MAX_START_LENGTH)
    assert.throws(() => (node[name] = 1), /invalid/, 'what is not a string is refused as before')
  }
  for (const name of curves) {
    const node = handle('particles')
    for (const value of curveForms) {
      node[name] = value
      assert.equal(node[name], value, `${name}: a curve of ${value.length} characters is kept`)
    }
    // one point of ten million values (a split of it is ten million entries)
    node[name] = '0,1' + ',1'.repeat(10_000_000)
    assert.equal(node[name].length, m.PARTICLES_MAX_CURVE_LENGTH, `${name}: a long curve is cut`)
    assert.equal(m.createNode('particles', { [name]: '|'.repeat(1e5) })[name].length, m.PARTICLES_MAX_CURVE_LENGTH)
    node[name] = null
    assert.equal(node[name], null)
  }
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

// Runs one emitter: creates it, then one update per step ({ delta, x }: the step's time, and where the emitter is
// along x), and hands `check` what each step sent back: the particle count, the packed sizes, colours and UVs (in
// pool order: the blending is additive, so nothing is sorted), and how many random numbers the step drew.
const stepEmitter = (config, steps, check) =>
  runProbe(
    bundle,
    ({ THREE }, { config, steps, check }) => {
      let output
      self.postMessage = msg => {
        output = msg
      }
      let randoms = 0
      const random = Math.random
      Math.random = () => {
        randoms++
        return random()
      }
      self.onmessage({ data: config })
      const max = Math.max(1, config.max)
      const results = []
      for (const { delta, x = 0 } of steps) {
        randoms = 0
        output = null
        self.onmessage({
          data: {
            op: 'update',
            emitterId: config.id,
            delta,
            camPosition: [0, 0, 0],
            matrixWorld: new THREE.Matrix4().makeTranslation(x, 0, 0).toArray(),
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
        assert.equal(output?.op, 'update', 'the step is answered')
        const n = output.n
        results.push({
          n,
          randoms,
          size: Array.from(output.aSize.subarray(0, n)),
          color: Array.from(output.aColor.subarray(0, n * 3)),
          uv: Array.from(output.aUV.subarray(0, n * 4)),
        })
      }
      Math.random = random
      new Function('results', 'assert', `(${check})(results, assert)`)(results, assert)
    },
    { config, steps, check: check.toString() }
  )

// The starts of a step are counted exactly through the random numbers it draws: a `life` of '0~0' draws one for each
// start (and is 0, so each particle is free again at once and the pool never runs out), the point shape none, and
// nothing else in these steps draws any.
const startsEveryStep = { ...emitterConfig, life: '0~0' }

test('particle worker: one step starts exactly as many particles as the pool holds, over its rate and all its bursts', () =>
  // a rate of the node's largest (10,000 asked in a step of 0.1 s) and 64 bursts of the whole pool, in a cycle that
  // starts its bursts again every step: each step starts 8 (the pool), not 10,000 + 64 x 8
  stepEmitter(
    {
      ...startsEveryStep,
      rate: 100000,
      duration: 0.01,
      bursts: Array.from({ length: 64 }, () => ({ time: 0, count: 8 })),
    },
    [{ delta: 0.1 }, { delta: 0.1 }, { delta: 0.1 }],
    (results, assert) =>
      assert.deepEqual(
        results.map(step => step.randoms),
        [8, 8, 8]
      )
  ))

test('particle worker: emission over distance shares the step budget with the rate', () =>
  // 64 a metre, moving a metre a step (64 distance emits of one each), and 5 a second by the rate: the first step has
  // not moved yet (5 by the rate), then each step starts 5 by the rate and 3 by the distance, the pool's 8 in all
  stepEmitter(
    { ...startsEveryStep, rate: 5, rateOverDistance: 64 },
    [
      { delta: 1, x: 0 },
      { delta: 1, x: 1 },
      { delta: 1, x: 2 },
    ],
    (results, assert) =>
      assert.deepEqual(
        results.map(step => step.randoms),
        [5, 8, 8]
      )
  ))

test('particle worker: emission over distance alone is held to the pool too', () =>
  // 64 a metre, moving a metre and then two: 64 and then 128 distance emits, of which each step starts 8
  stepEmitter(
    { ...startsEveryStep, rateOverDistance: 64 },
    [
      { delta: 0.1, x: 0 },
      { delta: 0.1, x: 1 },
      { delta: 0.1, x: 3 },
    ],
    (results, assert) =>
      assert.deepEqual(
        results.map(step => step.randoms),
        [0, 8, 8]
      )
  ))

test('particle worker: the step budget starts again with every step', () =>
  // two a second into a pool of four, each living a second and a half: every step starts two (six in all by the
  // third step, more than the pool), reusing the ones that died
  runEmitter({ ...emitterConfig, max: 4, rate: 2, life: '1.5' }, [1, 1, 1, 1], [2, 2, 2, 2]))

test('particle worker: a free particle is looked for from the start of the pool in every step, and found in order', () =>
  // One a second into a pool of four, each living 2.5 s. The size is the step's number (linear over a cycle of 64 s,
  // from 0 to 64), so each slot's size says in which step it was started; the packed sizes are in pool order.
  // Step 4 starts slot 0 again (it died in step 3) while slot 2 still lives: [4, 3]. Step 5 then takes slot 1: [4, 5].
  stepEmitter(
    { ...emitterConfig, max: 4, rate: 1, life: '2.5', size: '0-64', duration: 64 },
    Array.from({ length: 5 }, () => ({ delta: 1 })),
    (results, assert) =>
      assert.deepEqual(
        results.map(step => step.size),
        [[1], [1, 2], [2, 3], [4, 3], [4, 5]]
      )
  ))

// Why the search's cost is counted through the pool itself: a search that starts again from the first particle for
// every start finds the same particle as one that goes on from where the step's last one was found (the particles
// before it were in use then, and nothing ages until the step's starts are done), so no output tells them apart; only
// the work does, and time is not asserted here. The pool's particles are made inside the worker, but each is pushed
// into the pool: the probe catches them there and makes their `age` and `life` accessors that count their reads.
test('particle worker: a step reads each particle a fixed number of times, however many it starts', () =>
  runProbe(
    bundle,
    ({ THREE }, { config }) => {
      self.postMessage = () => {}
      let reads = 0
      let caught = 0
      const push = Array.prototype.push
      Array.prototype.push = function (...items) {
        for (const item of items) {
          if (item && typeof item === 'object' && 'emissionRotation' in item) {
            caught++
            for (const key of ['age', 'life']) {
              let value = item[key]
              Object.defineProperty(item, key, {
                get() {
                  reads++
                  return value
                },
                set(next) {
                  value = next
                },
              })
            }
          }
        }
        return Reflect.apply(push, this, items)
      }
      try {
        self.onmessage({ data: config })
      } finally {
        Array.prototype.push = push
      }
      const max = config.max
      assert.equal(caught, max, 'the probe reached every particle of the pool')
      // each step starts the whole pool (the particles of the step before have all died): 2,000 starts; a search
      // from the first particle for each start would read about 2,000 x 2,000 x 2 times
      for (let step = 0; step < 3; step++) {
        reads = 0
        self.onmessage({
          data: {
            op: 'update',
            emitterId: config.id,
            delta: 1,
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
        assert.ok(reads >= 4 * max, `step ${step}: the probe sees the reads (${reads})`)
        assert.ok(reads <= 12 * max, `step ${step}: ${reads} reads of age and life for a pool of ${max}`)
      }
    },
    { config: { ...emitterConfig, max: 2000, rate: 100000, life: '0.5' } }
  ))

test('particle worker: only the first 64 points of an over-life curve count, for sizes and for colours', () =>
  // eight particles (the pool) 90% through their lives: past the 64th point (at 63%), which is the last one read. The 65th and
  // later would make each a hundred times as large, and red.
  stepEmitter(
    {
      ...emitterConfig,
      rate: 10,
      life: '1',
      size: '1',
      sizeOverLife: Array.from({ length: 100 }, (_, i) => `${i / 100},${i < 64 ? 1 : 100}`).join('|'),
      colorOverLife: Array.from({ length: 100 }, (_, i) => `${i / 100},${i < 64 ? 'white' : 'red'}`).join('|'),
    },
    [{ delta: 0.9 }],
    (results, assert) => {
      const [{ n, size, color }] = results
      assert.equal(n, 8)
      assert.deepEqual(size, Array(8).fill(1))
      assert.deepEqual(color, Array(24).fill(1), 'white, not red')
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

// What the worker parses is a text of the node's limits at most (Particles.js). Every split it makes of one is bounded
// too: a curve into its first 64 points, a point and a start value into the two values they hold. The probe records
// the longest result of each kind of split while two emitters are made from texts of those limits, all separators.
test('particle worker: no split of a start value or a curve is longer than what is read of it', () =>
  runProbe(
    bundle,
    (_module, { configs }) => {
      self.postMessage = () => {}
      const longest = {}
      const split = String.prototype.split
      String.prototype.split = function (separator, limit) {
        const parts = Reflect.apply(split, this, [separator, limit])
        longest[separator] = Math.max(longest[separator] ?? 0, parts.length)
        return parts
      }
      try {
        for (const config of configs) self.onmessage({ data: config })
      } finally {
        String.prototype.split = split
      }
      assert.deepEqual(longest, { '-': 2, '~': 2, '|': 64, ',': 2 })
    },
    {
      configs: [
        {
          ...emitterConfig,
          id: 'linear',
          life: '1' + '-1'.repeat(127), // 256 characters each
          speed: '1' + '~1'.repeat(127),
          color: 'red' + '-red'.repeat(63),
          sizeOverLife: '0' + ',1'.repeat(2047), // 4,096 characters each
          colorOverLife: '0' + ',red'.repeat(1023),
          alphaOverLife: '0,1' + '|0,1'.repeat(1023),
        },
        { ...emitterConfig, id: 'random', color: 'red' + '~red'.repeat(63) },
      ],
    }
  ))

test('particle worker: a spritesheet of a billion rows and columns is bounded to 256 each', () =>
  runEmitter({ ...emitterConfig, rate: 10, spritesheet: [1e9, 1e9, 30, true] }, [0.5, 0.5], [5, 8]))

test('particle worker: spritesheet rows and columns are read by the number rule (a string digit counts, an object does not)', () =>
  runEmitter({ ...emitterConfig, rate: 10, spritesheet: ['2', null, 30, false] }, [0.5], [5]))

// one particle of a long life, started in the first step, on a sheet of one row of four frames (frame k has its u0 at
// k / 4); a check reads the u0 of each step
const oneParticle = { ...emitterConfig, life: '100', bursts: [{ time: 0, count: 1 }] }
const sixSeconds = Array.from({ length: 6 }, () => ({ delta: 1 }))

test('particle worker: a spritesheet frame rate that cannot animate shows the first frame, and every step is answered', () =>
  Promise.all(
    // ([1] is an object: not a number by the engine's rule, though it would convert to 1)
    [NaN, -30, 0, '', 'fast', null, undefined, {}, [1]].map(rate =>
      stepEmitter({ ...oneParticle, spritesheet: [1, 4, rate, true] }, sixSeconds, (results, assert) =>
        assert.deepEqual(
          results.map(step => step.uv[0]),
          [0, 0, 0, 0, 0, 0]
        )
      )
    )
  ))

test('particle worker: a spritesheet frame rate is read by the number rule and bounded; the frame is always one of the sheet', () =>
  Promise.all([
    // one frame a second: frames 1, 2, 3, 0, 1, 2 (it loops)
    stepEmitter({ ...oneParticle, spritesheet: [1, 4, 1, true] }, sixSeconds, (results, assert) =>
      assert.deepEqual(
        results.map(step => step.uv[0]),
        [0.25, 0.5, 0.75, 0, 0.25, 0.5]
      )
    ),
    stepEmitter({ ...oneParticle, spritesheet: [1, 4, '1', true] }, sixSeconds, (results, assert) =>
      assert.deepEqual(
        results.map(step => step.uv[0]),
        [0.25, 0.5, 0.75, 0, 0.25, 0.5]
      )
    ),
    // a rate without end, or past the bound, is the bound (1,000 a second): on a sheet of three frames, frames 1000,
    // 2000, 3000, ... are 1, 2, 0, ...
    ...[Infinity, 1e300, 5000].map(rate =>
      stepEmitter({ ...oneParticle, spritesheet: [1, 3, rate, true] }, sixSeconds, (results, assert) =>
        assert.deepEqual(
          results.map(step => Math.round(step.uv[0] * 3)),
          [1, 2, 0, 1, 2, 0]
        )
      )
    ),
    // a particle that never dies (a life that is not a number) through a step whose time is not one: its frame time is
    // NaN from then on, and its frame the first
    stepEmitter(
      { ...oneParticle, life: 'forever', spritesheet: [1, 4, 1, true] },
      [{ delta: 1 }, { delta: NaN }, { delta: 1 }],
      (results, assert) =>
        assert.deepEqual(
          results.map(step => step.uv[0]),
          [0.25, 0, 0]
        )
    ),
  ]))

test('particle worker: a spritesheet loops by the truth of its loop flag, as it always has', () =>
  Promise.all([
    ...[false, 0, '', null].map(loop =>
      // one frame a second, no loop: it stays on the last frame (3) from the third second on
      stepEmitter({ ...oneParticle, spritesheet: [1, 4, 1, loop] }, sixSeconds, (results, assert) =>
        assert.deepEqual(
          results.map(step => step.uv[0]),
          [0.25, 0.5, 0.75, 0.75, 0.75, 0.75]
        )
      )
    ),
    ...[true, 1, 'true'].map(loop =>
      stepEmitter({ ...oneParticle, spritesheet: [1, 4, 1, loop] }, sixSeconds, (results, assert) =>
        assert.deepEqual(
          results.map(step => step.uv[0]),
          [0.25, 0.5, 0.75, 0, 0.25, 0.5]
        )
      )
    ),
  ]))

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

// runs `fn` with console.warn and unhandled rejections recorded; returns both once the rejections have settled
async function watchFailures(fn) {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const warnings = []
  const realWarn = console.warn
  console.warn = (...line) => warnings.push(line.join(' '))
  try {
    fn()
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    console.warn = realWarn
    process.off('unhandledRejection', onUnhandled)
  }
  return { unhandled, warnings }
}

test('a real node whose async mount rejects is reported when it is activated and when it is remounted', async () => {
  const world = {
    network: { isServer: false },
    resolveURL: url => url,
    loader: { get: () => null, load: () => Promise.reject(new Error('asset refused')) },
  }
  let avatar
  const { unhandled, warnings } = await watchFailures(() => {
    avatar = m.createNode('avatar', { src: 'asset://missing.vrm' })
    avatar.activate({ world, entity: null }) // Node.activate: mount() is async and its load rejects
    assert.equal(avatar.mounted, true)
    assert.equal(avatar.remount(), true) // Node.remount: the same, again
  })
  assert.deepEqual(unhandled, [])
  assert.deepEqual(
    warnings.filter(line => line.startsWith('[avatar]')),
    ['[avatar] not loaded: asset refused', '[avatar] not loaded: asset refused'],
    'one report from the activate, one from the remount'
  )
  assert.equal(avatar.mounted, true, 'the node stays mounted, without its file')
})

test('a failed load whose reason throws when it is read is still reported, and nothing is left unhandled', async () => {
  // what an avatar's onLoad (a script's function) can throw: an object whose message is a getter that throws, and a
  // Proxy that throws on every trap
  const getterError = {
    get name() {
      throw new Error('name getter')
    },
    get message() {
      throw new Error('message getter')
    },
  }
  const trap = () => {
    throw new Error('trap')
  }
  const proxyError = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, has: trap })
  const { unhandled, warnings } = await watchFailures(() => {
    m.watchLoad({ name: 'probe' }, Promise.reject(getterError))
    m.watchLoad({ name: 'probe' }, Promise.reject(proxyError))
    m.watchLoad({ name: 'probe' }, Promise.reject('a plain text'))
    // and a real avatar, whose script's onLoad throws such an object from inside its async mount
    const instance = { setEmote() {}, setVisible() {}, move() {}, destroy() {} }
    const avatar = m.createNode('avatar', {
      factory: { create: () => instance },
      onLoad: () => {
        throw getterError
      },
    })
    avatar.activate({ world: { setHot() {}, avatars: { add() {}, remove() {} } }, entity: null })
  })
  assert.deepEqual(unhandled, [])
  assert.deepEqual(warnings, [
    '[probe] not loaded: error',
    '[probe] not loaded: error',
    '[probe] not loaded: a plain text',
    '[avatar] not loaded: error',
  ])
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

  // a panner as strict as the browser's, on a node whose transform holds a NaN or a number too large for a float: an
  // AudioParam's ramp takes a float (WebIDL), which must be finite once it is rounded to 32 bits
  const ramps = []
  const param = {
    linearRampToValueAtTime: value =>
      Number.isFinite(Math.fround(value)) ? ramps.push(value) : assert.fail(`ramp to ${value}`),
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
    node.matrixWorld.elements[12] = 1e100 // finite as a double, not as a float
    node.updatePannerPosition()
    assert.equal(ramps.length, 6, `${type}: a position past what a float holds is not`)
    node.matrixWorld.elements[12] = 3e38 // the largest floats are still positions
    node.updatePannerPosition()
    assert.equal(ramps.length, 12, `${type}: a position a float holds is written`)
  }
})

test('audio: a playback rate is a finite float; a NaN is 1, the rest is bounded; only a playing source is ramped', () => {
  const ramps = []
  // the source's playbackRate as strict as the browser's: its ramp takes a float, finite once rounded to 32 bits
  const playbackRate = {
    linearRampToValueAtTime(value, endTime) {
      if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new TypeError(`ramp to ${value}`)
      ramps.push([value, endTime])
    },
  }
  const node = m.createNode('audio')
  node.ctx = { world: { audio: { ctx: { currentTime: 10 }, lastDelta: 0.5 } } }
  node.source = { playbackRate }
  const proxy = node.getProxy()
  for (const [given, kept] of [
    [2, 2],
    [0.5, 0.5],
    [0, 0],
    [-1, -1],
    ['1.5', 1.5], // a primitive is converted, as the ramp itself did
    [NaN, 1],
    [undefined, 1],
    [{ valueOf: () => 3 }, 1], // an object is not (its valueOf is the script's code)
    [Infinity, 1000],
    [-Infinity, -1000],
    [1e100, 1000],
    [-1e100, -1000],
  ]) {
    ramps.length = 0
    proxy.setPlaybackRate(given) // a playing node: the value goes straight to the ramp
    assert.deepEqual(ramps, [[kept, 10.5]], `setPlaybackRate(${String(given)})`)
  }
  // a node that is not playing has nothing to ramp, on the client and on the server (which has no audio)
  for (const ctx of [{ world: { audio: { ctx: { currentTime: 0 }, lastDelta: 0 } } }, { world: { audio: null } }]) {
    const idle = m.createNode('audio')
    idle.ctx = ctx
    idle.getProxy().setPlaybackRate(2)
  }
})

test("video: a time is finite and not negative before it reaches the element's currentTime", () => {
  const times = []
  const node = m.createNode('video')
  // the element's currentTime as strict as the browser's: a double that must be finite
  node.instance = {
    get currentTime() {
      return times.at(-1) ?? 0
    },
    set currentTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`currentTime = ${value}`)
      times.push(value)
    },
  }
  const proxy = node.getProxy()
  for (const [given, kept] of [
    [12.5, 12.5],
    [0, 0],
    ['3', 3],
    [NaN, 0],
    [-1, 0],
    [Infinity, 1e9],
    [{}, 0],
  ]) {
    proxy.time = given
    assert.equal(times.at(-1), kept, `time = ${String(given)}`)
    proxy.currentTime = given // (the older name)
    assert.equal(times.at(-1), kept, `currentTime = ${String(given)}`)
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
