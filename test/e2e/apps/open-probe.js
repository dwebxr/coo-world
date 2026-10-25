// e2e probe (browser): world.open() policy, object URLs and the fetch option whitelist. The harness drives it
// through app.state.cmd and reads app.state.results.
const base = props.base
const results = {}
app.state = { cmd: null, results }
const commands = {
  async openBlob() {
    const blob = await (await fetch(base + '/')).blob()
    world.open(URL.createObjectURL(blob))
    return { type: blob.type }
  },
  openJavascript() {
    world.open('javascript:1')
    return {}
  },
  openData() {
    world.open('data:text/html,x')
    return {}
  },
  async openAsset() {
    world.open('/assets/crash-block.glb')
    world.open('asset://crash-block.glb')
    // percent-encoded spellings can reach the same files (fastify 5.2 served them; 5.12 answers 404), so they
    // are rejected as well
    world.open('/%61ssets/crash-block.glb')
    world.open(base + '/%61ssets/crash-block.glb')
    const encoded = await fetch(base + '/%61ssets/crash-block.glb')
    return { encodedStatus: encoded.status }
  },
  openPopup() {
    world.open(base + '/status', true)
    return {}
  },
  async blobType() {
    const blob = await (await fetch(base + '/')).blob()
    const url = URL.createObjectURL(blob.slice(0, 5, 'text/html'))
    const resp = await fetch(url)
    return { contentType: resp.headers['content-type'], length: (await resp.text()).length }
  },
  async image() {
    const blob = await (await fetch(props.png)).blob()
    const image = app.create('image', { src: URL.createObjectURL(blob), width: 1, position: [0, 1, 0] })
    app.add(image)
    return { type: blob.type }
  },
  async fetchOptions() {
    const resp = await fetch(base + '/status', {
      method: 'GET',
      headers: { 'x-e2e': '1', bad: 1 },
      signal: 'not-a-signal',
      integrity: 'sha256-bogus',
      cache: 'no-store',
    })
    return { ok: resp.ok, status: resp.status, json: typeof (await resp.json()) }
  },
}
let busy = false
app.on('update', () => {
  const cmd = app.state.cmd
  if (busy || !cmd) return
  busy = true
  Promise.resolve()
    .then(() => commands[cmd]())
    .then(
      value => {
        results[cmd] = { ok: true, ...value }
      },
      err => {
        results[cmd] = { ok: false, error: String(err && err.message) }
      }
    )
    .then(() => {
      app.state.cmd = null
      busy = false
    })
})
