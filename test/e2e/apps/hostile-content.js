// e2e hostile-content app: every value here is one a node must survive (test/e2e/hostile-content.mjs reads what the
// nodes kept and what the page did with it). Client only: the server mounts none of these.
if (world.isClient) {
  const made = {}

  // a world-space UI of a billion pixels a side, holding a text of half a million characters
  made.bigUI = app.create('ui', {
    id: 'big-ui',
    space: 'world',
    width: 1e9,
    height: 1e9,
    res: 1e9,
    size: 0.000001,
    backgroundColor: 'black',
    position: [0, 2, 0],
  })
  made.bigUI.add(app.create('uitext', { id: 'big-text', value: 'word '.repeat(100000), fontSize: 1e9, color: 'white' }))
  app.add(made.bigUI)

  // screen-space UIs: sizes that are not numbers a canvas can have, and the two cursors
  made.nanUI = app.create('ui', { id: 'nan-ui', space: 'screen', width: NaN, height: Infinity, res: NaN })
  made.nanUI.position.set(0.9, 0.1, 0)
  app.add(made.nanUI)

  made.keywordUI = app.create('ui', {
    id: 'keyword-ui',
    space: 'screen',
    width: 120,
    height: 120,
    backgroundColor: 'green',
    pivot: 'center',
  })
  made.keywordUI.position.set(0.25, 0.5, 0)
  made.keywordUI.cursor = 'crosshair'
  app.add(made.keywordUI)

  made.imageCursorUI = app.create('ui', {
    id: 'image-cursor-ui',
    space: 'screen',
    width: 120,
    height: 120,
    backgroundColor: 'red',
    pivot: 'center',
  })
  made.imageCursorUI.position.set(0.75, 0.5, 0)
  made.imageCursorUI.cursor = `url(${props.cursorProbe}), auto`
  app.add(made.imageCursorUI)

  // particles: a pool, a rate and bursts without end, particles with no life, a spritesheet of a billion frames a
  // side, and an image that does not exist
  made.particles = app.create('particles', {
    id: 'hostile-particles',
    max: 1e9,
    rate: Infinity,
    life: '0',
    duration: 0,
    timescale: Infinity,
    bursts: Array.from({ length: 1000 }, (_, i) => ({ time: i / 1000, count: Infinity })),
    spritesheet: [1e9, 1e9, 30, true],
    image: 'asset://no-such-particle-image.png',
    position: [2, 1, 0],
  })
  app.add(made.particles)

  // and an ordinary emitter next to it, which must keep running
  made.plain = app.create('particles', { id: 'plain-particles', max: 50, rate: 20, life: '5', position: [-2, 1, 0] })
  app.add(made.plain)

  made.sky = app.create('sky', {
    id: 'hostile-sky',
    rotationY: NaN,
    sunIntensity: Infinity,
    fogNear: NaN,
    fogFar: Infinity,
  })
  app.add(made.sky)

  made.audio = app.create('audio', {
    id: 'hostile-audio',
    volume: Infinity,
    refDistance: -1,
    maxDistance: 0,
    rolloffFactor: NaN,
    coneOuterGain: 9,
  })
  app.add(made.audio)

  made.action = app.create('action', { id: 'hostile-action', label: 'L'.repeat(100000), position: [0, 1, 0] })
  app.add(made.action)
}
