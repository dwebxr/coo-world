// e2e probe: what a script can and cannot reach. Runs on the server (reports through chat) and in the
// browser (reports through app.state). Every write below must fail inside this script only.
const TAG = 'P1_SANDBOX'
const base = props.base
const results = { stash: false }
const report = () => {
  if (world.isServer) world.chat({ id: uuid(), body: TAG + ' ' + JSON.stringify(results) }, true)
  else app.state = { [TAG]: results }
}
const attempt = (name, fn) => {
  try {
    fn()
    results[name] = 'ok'
  } catch (err) {
    results[name] = err.constructor === TypeError ? 'TypeError' : 'threw ' + err.name
  }
}
const chainFrozen = value => {
  for (let proto = Object.getPrototypeOf(value); proto; proto = Object.getPrototypeOf(proto)) {
    if (!Object.isFrozen(proto)) return false
  }
  return true
}
const describeError = err => ({
  isError: err instanceof Error,
  name: err && err.name,
  chainFrozen: err !== null && typeof err === 'object' && chainFrozen(err),
  hasCause: err !== null && typeof err === 'object' && 'cause' in err,
  objectProps: Object.getOwnPropertyNames(err || {}).filter(key => {
    const desc = Object.getOwnPropertyDescriptor(err, key)
    return 'value' in desc && desc.value !== null && typeof desc.value === 'object'
  }),
})

// intrinsics and endowments
attempt('arrayProto', () => {
  Array.prototype.probe = 1
})
attempt('objectProto', () => {
  Object.prototype.polluted = 1
})
attempt('mathWrite', () => {
  Math.floor = () => 0
})
attempt('endowmentWrite', () => {
  Vector3 = 1 // eslint-disable-line no-global-assign
})
attempt('endowmentDefine', () => {
  Object.defineProperty(globalThis, 'Vector3', { value: 1 })
})
attempt('consoleStash', () => {
  console.marker = 1
})
attempt('helperStash', () => {
  num.marker = 1
})
attempt('ownGlobal', () => {
  globalThis.stash = 'secret'
  results.stash = globalThis.stash === 'secret'
})
results.arrayProbeLeak = Array.prototype.probe
results.floor = Math.floor(1.5)
results.mathRandom = typeof Math.random
results.evalType = typeof eval
results.hardenType = typeof harden

// host errors reach the script as intrinsic errors
try {
  world.createLayerMask('bogus')
} catch (err) {
  results.syncError = describeError(err)
}

const run = async () => {
  try {
    await world.load('model', 'asset://does-not-exist.glb')
    results.loadError = 'resolved'
  } catch (err) {
    results.loadError = describeError(err)
  }
  // the blob facade and object URLs
  const resp = await fetch(base + '/')
  const blob = await resp.blob()
  results.blob = {
    protoIsObject: Object.getPrototypeOf(blob) === Object.prototype,
    frozen: Object.isFrozen(blob),
    keys: Object.keys(blob).sort(),
    stream: typeof blob.stream,
    type: blob.type,
    sliceType: blob.slice(0, 5, 'image/png').type,
    textStart: (await blob.text()).slice(0, 9),
  }
  attempt('blobProtoWrite', () => {
    Object.getPrototypeOf(blob).text = 1
  })
  attempt('objectUrlNonFacade', () => URL.createObjectURL({ size: 1, type: 'text/html' }))
  const htmlUrl = URL.createObjectURL(blob)
  results.objectUrlType = (await fetch(htmlUrl)).headers['content-type']
  const pngUrl = URL.createObjectURL(await (await fetch(props.png)).blob())
  results.objectUrlPngType = (await fetch(pngUrl)).headers['content-type']
  try {
    await resp.json()
    results.readerError = 'resolved'
  } catch (err) {
    results.readerError = describeError(err)
  }
  results.done = true
  report()
}
report()
run().catch(err => {
  results.failed = String(err && err.stack)
  report()
})
