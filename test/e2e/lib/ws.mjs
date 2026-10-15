// A minimal wire client for the world's websocket protocol (the same packets the browser client uses),
// built on the WebSocket global of Node 22+, so the harness needs no extra dependency.
import { once } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { REPO_ROOT } from './common.mjs'

const { readPacket, writePacket } = await import(pathToFileURL(path.join(REPO_ROOT, 'src/core/packets.js')))

export class WireClient {
  constructor(port, label = 'wire') {
    this.port = port
    this.label = label
    this.inbox = []
    this.waiters = []
  }

  async connect(name = this.label) {
    const ws = new WebSocket(`ws://localhost:${this.port}/ws?authToken=&name=${encodeURIComponent(name)}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('message', event => {
      const [method, data] = readPacket(new Uint8Array(event.data))
      if (!method) return
      this.inbox.push({ method, data })
      for (const waiter of [...this.waiters]) waiter.check()
    })
    ws.addEventListener('error', () => {})
    await once(ws, 'open')
    const snap = await this.waitFor(m => m.method === 'onSnapshot', { timeout: 20000 })
    this.id = snap.data.id
    this.snapshot = snap.data
    this.authToken = snap.data.authToken
    return this
  }

  send(name, data) {
    this.ws.send(writePacket(name, data))
  }

  mark() {
    return this.inbox.length
  }

  since(from) {
    return this.inbox.slice(from)
  }

  waitFor(pred, { timeout = 10000, from = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let idx = from
      const remove = () => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
      }
      const timer = setTimeout(() => {
        remove()
        reject(new Error(`[${this.label}] timed out waiting for a packet`))
      }, timeout)
      const waiter = {
        check: () => {
          for (; idx < this.inbox.length; idx++) {
            const m = this.inbox[idx]
            if (pred(m)) {
              remove()
              clearTimeout(timer)
              resolve(m)
              return
            }
          }
        },
      }
      this.waiters.push(waiter)
      waiter.check()
    })
  }

  // probe scripts report through world.chat() with a tag prefix; returns the parsed JSON payload
  waitForReport(tag, options) {
    return this.waitFor(
      m => m.method === 'onChatAdded' && typeof m.data?.body === 'string' && m.data.body.startsWith(`${tag} `),
      options
    ).then(m => JSON.parse(m.data.body.slice(tag.length + 1)))
  }

  async becomeAdmin(code = 'e2e') {
    const from = this.mark()
    this.send('command', { cmd: 'admin', value: code, args: ['admin', code] })
    await this.waitFor(m => m.method === 'onEntityModified' && m.data.id === this.id && m.data.rank === 2, { from })
  }

  installApp({ id, script, model = 'asset://crash-block.glb', props = {}, position = [0, 0, 0] }) {
    this.send('blueprintAdded', {
      id: `${id}-bp`,
      version: 0,
      name: id,
      image: null,
      author: null,
      url: null,
      desc: null,
      model,
      script,
      props,
      preload: false,
      public: false,
      locked: false,
      frozen: false,
      unique: false,
      scene: false,
      disabled: false,
    })
    this.send('entityAdded', {
      id,
      type: 'app',
      blueprint: `${id}-bp`,
      position,
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      mover: null,
      uploader: null,
      pinned: false,
      state: {},
    })
  }

  close() {
    this.ws?.close()
  }
}

export async function snapshot(port) {
  const client = await new WireClient(port, 'snapshot').connect()
  client.close()
  return client.snapshot
}
