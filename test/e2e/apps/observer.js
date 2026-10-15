// e2e probe: a bystander app. It must see none of the other probes' writes and must keep running while
// they crash. Reports once on start and then a heartbeat every second (server: chat, browser: app.state).
const TAG = 'P1_OBSERVER'
const BEAT = 'P1_OBSERVER_BEAT'
const look = () => ({
  stash: typeof globalThis.stash,
  arrayProbe: typeof Array.prototype.probe,
  crasher: typeof Array.prototype.crasher,
  vectorType: typeof Vector3,
  floor: Math.floor(1.5),
  consoleMarker: typeof console.marker,
  helperMarker: typeof num.marker,
})
const report = (tag, data) => {
  if (world.isServer) world.chat({ id: uuid(), body: tag + ' ' + JSON.stringify(data) }, true)
  else app.state = Object.assign({}, app.state, { [tag]: data })
}
report(TAG, look())
let elapsed = 0
let beats = 0
app.on('update', delta => {
  elapsed += delta
  if (elapsed >= 1 && beats < 120) {
    elapsed = 0
    beats++
    report(BEAT, { n: beats, ...look() })
  }
})
