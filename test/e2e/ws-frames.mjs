// Raw RFC 6455 frame-count probe; no world, WebGL or database needed.
// usage: node test/e2e/ws-frames.mjs --engine=chromium|webkit|firefox
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'

const engine = process.argv.find(arg => arg.startsWith('--engine='))?.split('=')[1] || 'chromium'
const browserType = { chromium, firefox, webkit }[engine]
assert.ok(browserType, `unknown engine: ${engine}`)
const results = []
const errors = []
const sockets = new Set()
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<!doctype html><title>WebSocket frame probe</title>')
})
server.on('upgrade', (req, socket, head) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => {})
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  const label = new URL(req.url, 'http://localhost').searchParams.get('label')
  let buffer = Buffer.alloc(0)
  let current = null
  const onData = chunk => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    try {
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15
        const fin = !!(buffer[0] & 128)
        assert.equal(buffer[0] & 112, 0, 'no negotiated extensions')
        assert.ok(buffer[1] & 128, 'client frames are masked')
        let length = buffer[1] & 127
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        assert.ok(length <= 65536, 'probe frame at most 64 KiB')
        if (buffer.length < offset + 4 + length) return
        const mask = buffer.subarray(offset, offset + 4)
        offset += 4
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3]
        buffer = buffer.subarray(offset + length)
        if (opcode === 8) {
          socket.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload]))
          return
        }
        if (opcode === 2) {
          assert.equal(current, null, 'previous message finished')
          current = { label, frames: 0, bytes: 0 }
        } else assert.equal(opcode, 0, 'only binary or continuation frames')
        assert.ok(current)
        current.frames++
        for (let i = 0; i < payload.length; i++) assert.equal(payload[i], ((current.bytes + i) * 31 + 7) & 255)
        current.bytes += length
        if (fin) {
          results.push(current)
          current = null
          socket.write(Buffer.from([0x81, 2, 111, 107])) // text "ok"
        }
      }
    } catch (err) {
      errors.push(err.message)
      socket.destroy()
    }
  }
  socket.on('data', onData)
  if (head.length) onData(head)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
let browser
try {
  browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  const base = `http://127.0.0.1:${server.address().port}`
  await page.goto(base)
  for (const kib of [1, 32, 64]) {
    for (const count of [1, 10]) {
      const label = `${kib}KiB-${count}`
      await page.evaluate(
        async ({ kib, count, label }) => {
          await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://${location.host}/ws?label=${label}`)
            let acked = 0
            const timer = setTimeout(() => {
              ws.close()
              reject(new Error(`ack timeout: ${label}`))
            }, 10000)
            ws.onerror = () => {
              clearTimeout(timer)
              reject(new Error(`ws error: ${label}`))
            }
            ws.onopen = () => {
              const packet = new Uint8Array(kib * 1024)
              for (let i = 0; i < packet.length; i++) packet[i] = (i * 31 + 7) & 255
              for (let i = 0; i < count; i++) ws.send(packet)
            }
            ws.onmessage = () => {
              if (++acked === count) {
                clearTimeout(timer)
                ws.close()
                resolve()
              }
            }
          })
        },
        { kib, count, label }
      )
      const messages = results.filter(result => result.label === label)
      assert.equal(messages.length, count)
      for (const message of messages) {
        assert.equal(message.bytes, kib * 1024)
        assert.ok(message.frames <= 2, `${engine} ${label}: ${message.frames} frames`)
      }
      console.log(
        `${engine} ${label}: ${messages.length} messages, max ${Math.max(...messages.map(m => m.frames))} frames`
      )
    }
  }
  assert.deepEqual(errors, [])
  assert.equal(results.length, 33)
  console.log(`${engine}: 33/33 messages passed`)
} finally {
  await browser?.close()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
