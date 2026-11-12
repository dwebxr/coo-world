// Access control and server secrets against the real server, over real sockets and without a browser.
//
// usage: node test/e2e/access-control.mjs [--port=3131]     (after `npm run build`; uses --port and --port+1)
//
// What it asks:
// - For each rule of test/lib/packetAccess.mjs (who may send which packet): a connection below the rank the rule
//   names sends a well-formed packet, and nothing comes of it. "Nothing" is observed three ways: a ping the sender
//   puts after the packet is answered (the server handles one connection's packets in order, so the packet has been
//   through its handler by then); the server's log line for the refusal, where the server writes one; and the
//   world's state as a connection that joins afterwards is told it (its join snapshot).
// - Wherever there is one, the positive control: the same payload from a connection that has the rank takes
//   effect, read the same way. A refusal without it shows only that the packet did nothing, which a malformed
//   payload would do too. Each case says in its result line whether it has one, and why not when it has none.
// - Identity: a session token with a forged signature, and one for a user that does not exist, do not connect as
//   the user they name.
// - Secrets: the server runs with a distinct sentinel value in every variable test/lib/envTable.mjs classes as a
//   secret (but DB_URI, which has to stay `local`). No sentinel is in what a visitor can get: the page, /env.js,
//   /status, /health, a visitor's and an admin's join snapshot, any packet any connection of the run received, and
//   the server's log; also not inside the tokens found there, which are decoded (JWT segments, base64, percent
//   escapes) and searched too. A second server with the wallet features on is searched the same way.
//
// What it does not ask (the tables name the tests that do): uploads and response headers (gate-extras.mjs,
// test/uploadRoutes.test.js), the relay packets (fullstack.mjs A8), /status (A8b), the wait after wrong admin codes
// and the right code afterwards (A14b), who a kick keeps out (A14c), an outdated client (A15), the rules of session
// tokens (test/sessionTokens.test.js), and the wallet flows themselves (token-gate.mjs, evm-wallet.mjs,
// evm-tips-gate.mjs). And what it cannot: it sends the payloads written here. A payload nobody thought of is not
// tried, and a secret that leaves the server some other way (an error page of a route not fetched here, a value
// encoded in a way the decoder does not undo) is not seen.
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  APPS_DIR,
  REPO_ROOT,
  TIMEOUT_SCALE,
  arg,
  createResults,
  ensureOut,
  eq,
  ok,
  sleep,
  waitUntil,
} from './lib/common.mjs'
import { installAsset, startServer } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const lib = file => import(pathToFileURL(path.join(REPO_ROOT, file)))
const { PACKET_RULES, REFUSED_EVENT_NAMES, namedCases, namesOfClass } = await lib('test/lib/packetAccess.mjs')
const { ENV_TABLE, envNamesOf } = await lib('test/lib/envTable.mjs')
const { SERVED_AS_BEFORE_ENV_NAMES, SERVED_ENV_NAMES } = await lib('src/core/extras/publicEnv.js')

const PORT = Number(arg('port', 3131))
const OUT = ensureOut()
const { record, step, finish } = createResults('access-control')
const wait = ms => ms * TIMEOUT_SCALE

// ---------- the mock the server's outbound calls go to (the AI provider and the chain RPCs) ----------

const mock = { ai: [], rpc: [] }
const mockServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/v1/messages')) {
      mock.ai.push({ key: req.headers['x-api-key'], body })
      // a reply in the shape of the Anthropic Messages API: a tiny valid app script
      res.end(
        JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: 'mock',
          content: [
            { type: 'thinking', thinking: '', signature: 'mock' },
            { type: 'text', text: 'app.on("update", () => {})' },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      )
      return
    }
    mock.rpc.push(req.url)
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'mock: no such method' } }))
  })
})
await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve))
const MOCK = `http://127.0.0.1:${mockServer.address().port}`

// ---------- the secrets, each with a value that is found nowhere else ----------

// name -> { value, needles, live }: what the server is started with, the parts of it to search for, and how the run
// shows that the server really uses it (a sentinel in a variable the server never read would prove nothing)
const SECRETS = {
  JWT_SECRET: {
    value: 'p14-sentinel-jwt-current-4f1c9a7e2b6d8035',
    live: 'the session token of a join verifies under it',
  },
  JWT_SECRET_PREVIOUS: {
    value: 'p14-sentinel-jwt-previous-91d3c05ab7e4f268',
    live: 'a token signed with it is taken for its user',
  },
  ADMIN_CODE: { value: 'p14-sentinel-admin-code-6b2e8d14', live: '/admin with it makes the admin of this run' },
  AI_API_KEY: { value: 'p14-sentinel-ai-key-c7a105e93f2b', live: 'the AI mock is sent it (x-api-key)' },
  LIVEKIT_API_SECRET: {
    value: 'p14-sentinel-livekit-secret-58e0b3d1a94c7f26',
    live: 'the voice token of a join verifies under it',
  },
  SOLANA_RPC_URL: {
    value: `${MOCK}/solana/p14-sentinel-solana-rpc-2d9f`,
    needles: ['p14-sentinel-solana-rpc-2d9f'],
    live: null, // read when a verified wallet's balance is asked for (token-gate.mjs); not in this run
  },
  PUBLIC_RPC_URL: {
    value: `${MOCK}/solana/p14-sentinel-public-rpc-7e31`,
    needles: ['p14-sentinel-public-rpc-7e31'],
    live: null, // the fallback of SOLANA_RPC_URL, which is set
  },
  EVM_RPC_URL_137: {
    value: `${MOCK}/evm/p14-sentinel-evm-rpc-a04b`,
    needles: ['p14-sentinel-evm-rpc-a04b'],
    live: null, // read for contract wallets, holdings and tips (evm-tips-gate.mjs); not in this run
  },
  ASSETS_S3_URI: {
    value: 's3://p14-sentinel-s3-key-55c2:p14-sentinel-s3-secret-9e7a@bucket.invalid/world',
    needles: ['p14-sentinel-s3-key-55c2', 'p14-sentinel-s3-secret-9e7a'],
    live: null, // ASSETS=local: the store is a folder, and this variable is not used
  },
}
// secrets of the table that get no sentinel, and why
const NOT_PLANTED = {
  DB_URI: 'has to be `local` here: a PostgreSQL address needs a database to connect to',
}
// every sentinel begins so: this alone in a surface is a finding, whichever secret it is part of
const SENTINEL = 'p14-sentinel-'
// Values that are public by design, as controls that the search reads what it is given:
const PUBLIC_MARKER = 'p14-public-marker-walletconnect' // a PUBLIC_ name the client reads: must be in /env.js
const COMMIT_MARKER = 'p14-public-marker-commit' // COMMIT_HASH: must be in /status
// LIVEKIT_API_KEY is the `iss` of every player's voice token, so every visitor can read it: public (envTable.mjs).
// It is found only by decoding that token, which is the control of the decoding.
const LIVEKIT_KEY = 'p14-public-marker-livekit-key'
// a PUBLIC_ name nothing reads: left out of /env.js, and named (not shown) in the start log
const UNLISTED = { name: 'PUBLIC_P14_UNLISTED', value: 'p14-sentinel-unlisted-public-0c6d' }

const secretEnv = Object.fromEntries(Object.entries(SECRETS).map(([name, secret]) => [name, secret.value]))
const baseEnv = {
  ...secretEnv,
  LIVEKIT_WS_URL: 'wss://livekit.invalid',
  LIVEKIT_API_KEY: LIVEKIT_KEY,
  AI_PROVIDER: 'anthropic',
  AI_MODEL: 'claude-opus-5-5',
  ANTHROPIC_BASE_URL: MOCK,
  PUBLIC_WALLETCONNECT_PROJECT_ID: PUBLIC_MARKER,
  COMMIT_HASH: COMMIT_MARKER,
  [UNLISTED.name]: UNLISTED.value,
}
// the second server: a world with the token gate, EVM sign-in and tips
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const walletEnv = {
  ...baseEnv,
  PUBLIC_TOKEN_MINT: SOL_MINT,
  PUBLIC_EVM_CHAIN_IDS: '137',
  PUBLIC_EVM_TIP_TOKENS: 'JPYC',
}

// ---------- helpers ----------

const b64u = value => Buffer.from(value).toString('base64url')
const hmac = (text, secret) => crypto.createHmac('sha256', secret).update(text).digest('base64url')
// an HS256 token as the server makes them (src/core/utils-server.js)
function signToken(payload, secret) {
  const head = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`
  return `${head}.${hmac(head, secret)}`
}
const verifies = (token, secret) => {
  const [head, body, signature] = String(token).split('.')
  return !!signature && hmac(`${head}.${body}`, secret) === signature
}
const tokenPayload = token => JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
const sessionPayload = userId => {
  const iat = Math.floor(Date.now() / 1000)
  return { userId, iat, exp: iat + 3600 }
}

const printable = text => {
  if (!text.length) return false
  let good = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) good++
  }
  return good / text.length > 0.9
}
// What a text says once its tokens are read: the first two segments of anything shaped like a JWT, every run of
// base64 or base64url characters (at each of the four alignments, since a run can begin inside a longer word), and
// percent escapes. Only decodings that are text are kept.
function decodings(text) {
  const out = []
  for (const match of text.matchAll(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
    for (const part of match[0].split('.').slice(0, 2)) {
      const decoded = Buffer.from(part, 'base64url').toString('utf8')
      if (printable(decoded)) out.push(decoded)
    }
  }
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{16,}/g)) {
    for (let offset = 0; offset < 4; offset++) {
      const decoded = Buffer.from(match[0].slice(offset), 'base64url').toString('latin1')
      if (printable(decoded)) out.push(decoded)
    }
  }
  if (/%[0-9A-Fa-f]{2}/.test(text)) {
    out.push(text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))))
  }
  return out
}
// a text and what its tokens decode to, two levels deep (a token inside a token)
function readings(text) {
  const first = decodings(text)
  return [text, ...first, ...first.flatMap(decodings)]
}
const needlesOf = () => [
  ...Object.entries(SECRETS).flatMap(([name, secret]) =>
    [secret.value, ...(secret.needles ?? [])].map(needle => ({ name, needle }))
  ),
  { name: UNLISTED.name, needle: UNLISTED.value },
  { name: 'any sentinel', needle: SENTINEL },
]
// -> the sentinels found in a surface, as sentences
function search(surface, text) {
  const found = new Set()
  const all = readings(text)
  for (const { name, needle } of needlesOf()) {
    all.forEach((reading, i) => {
      if (reading.includes(needle)) found.add(`${name} in ${surface}${i ? ' (inside a decoded token)' : ''}`)
    })
  }
  return [...found]
}
// every string in a decoded packet, keys included (the bytes are searched too: this also reads what msgpack split up)
function strings(value, out = [], seen = new Set()) {
  if (typeof value === 'string') out.push(value)
  else if (typeof value === 'number' || typeof value === 'bigint') out.push(String(value))
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    if (ArrayBuffer.isView(value)) {
      out.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1'))
    } else if (value instanceof Map) {
      for (const [key, item] of value) {
        strings(key, out, seen)
        strings(item, out, seen)
      }
    } else if (value instanceof Set || Array.isArray(value)) {
      for (const item of value) strings(item, out, seen)
    } else {
      for (const [key, item] of Object.entries(value)) {
        out.push(key)
        strings(item, out, seen)
      }
    }
  }
  return out
}

const blueprint = (id, extra = {}) => ({
  id,
  version: 0,
  name: id,
  image: null,
  author: null,
  url: null,
  desc: null,
  model: 'asset://crash-block.glb',
  script: null,
  props: {},
  preload: false,
  public: false,
  locked: false,
  frozen: false,
  unique: false,
  scene: false,
  disabled: false,
  ...extra,
})
const appEntity = (id, blueprintId, extra = {}) => ({
  id,
  type: 'app',
  blueprint: blueprintId,
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  mover: null,
  uploader: null,
  pinned: false,
  state: {},
  ...extra,
})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// A wire client that also keeps the bytes of every packet it receives. The listener is put on the socket in the
// turn the socket is made (WireClient.open has assigned it by its first wait), so the first packet cannot come
// before it.
class RawClient extends WireClient {
  open(name, options) {
    this.raw = []
    const opening = super.open(name, options)
    this.ws.addEventListener('message', event => this.raw.push(Buffer.from(event.data)))
    return opening
  }
}

// One server and the connections to it.
function world(server) {
  const port = server.port
  const clients = []
  let seq = 0
  const connect = async (label, options) => {
    const client = new RawClient(port, label)
    clients.push(client)
    await client.open(label, options)
    const snap = await client.waitFor(m => m.method === 'onSnapshot' || m.method === 'onKick', { timeout: wait(20000) })
    if (snap.method === 'onKick') throw new Error(`[${label}] refused: ${snap.data}`)
    client.id = snap.data.id
    client.snapshot = snap.data
    client.authToken = snap.data.authToken
    return client
  }
  // The barrier: a ping sent after a packet is answered once that packet has been through its handler (one
  // connection's packets are handled in the order they came). Also used on a connection that only receives: what
  // the server wrote to it before the pong has arrived before the pong.
  const barrier = async client => {
    const token = `barrier-${++seq}`
    const from = client.mark()
    client.send('ping', token)
    await client.waitFor(m => m.method === 'onPong' && m.data === token, { from, timeout: wait(10000) })
  }
  const send = async (client, name, data) => {
    client.send(name, data)
    await barrier(client)
  }
  // the world as a connection that joins now is told it
  const fresh = async (label = 'fresh') => {
    const client = await connect(`${label}-${++seq}`)
    client.close()
    return client.snapshot
  }
  const logFrom = () => server.out.length
  // the server's log is read through a pipe: a line written before a pong can arrive after it
  const logged = (from, text) =>
    waitUntil(() => server.out.slice(from).includes(text), {
      timeout: 10000,
      interval: 50,
      message: `the log line "${text}"`,
    })
  const close = async client => {
    client.close()
    await client.closed
  }
  return { port, clients, connect, barrier, send, fresh, logFrom, logged, close }
}

const entityOf = (snapshot, id) => snapshot.entities.find(entity => entity.id === id)
const blueprintOf = (snapshot, id) => snapshot.blueprints.find(item => item.id === id)
const got = (client, from, method, pred = () => true) =>
  client.since(from).filter(m => m.method === method && pred(m.data))
const said = (client, from, text) => got(client, from, 'onChatAdded', data => String(data?.body).includes(text))
const muted = snapshot => [...(snapshot.livekit?.muted ?? [])]

// the cases: every one the tables name has to run, and every one that runs has to be named (checked at the end)
const ran = new Map()
const run = (id, name, fn) =>
  step(`[${id}] ${name}`, fn).then(passed => {
    ran.set(id, (ran.get(id) ?? true) && passed)
    return passed
  })
const NONE = 'no positive control'

let main
let second
try {
  // ====================================================================================================
  // the first server: the harness's world (no wallet features), every secret set
  // ====================================================================================================
  main = await startServer({ port: PORT, env: baseEnv, logPath: path.join(OUT, 'access-control-server.log') })
  const w = world(main)
  const { connect, barrier, send, fresh, logFrom, logged, close } = w
  const base = `http://localhost:${PORT}`
  const CODE = SECRETS.ADMIN_CODE.value
  const probeScript = installAsset(main, path.join(APPS_DIR, 'access-probe.js'))

  // three connections: an admin (by the code), a builder (made one by the admin) and a visitor
  const admin = await connect('admin')
  await admin.becomeAdmin(CODE)
  const builder = await connect('builder')
  const visitor = await connect('visitor')
  const rank = async (target, value) => {
    const from = target.mark()
    admin.send('modifyRank', { playerId: target.id, rank: value })
    await target.waitFor(m => m.method === 'onEntityModified' && m.data.id === target.id && m.data.rank === value, {
      from,
      timeout: wait(10000),
    })
  }
  await rank(builder, 1)
  // an admin's join: a second user becomes admin and joins again with its token, which is when a snapshot is made
  // for a user whose stored rank is admin
  const adminJoin = await (async () => {
    const first = await connect('admin-join')
    await first.becomeAdmin(CODE)
    await close(first)
    await sleep(300)
    const again = await connect('admin-join', { authToken: first.authToken })
    eq(again.id, first.id, 'the same user')
    eq(entityOf(again.snapshot, again.id)?.rank, 2, 'joined as an admin')
    await close(again)
    return again
  })()
  // the probe app (apps/access-probe.js), installed by the admin
  {
    const from = visitor.mark()
    admin.installApp({ id: 'p14-probe', script: probeScript })
    await visitor.waitFor(m => m.method === 'onEntityAdded' && m.data.id === 'p14-probe', {
      from,
      timeout: wait(10000),
    })
  }
  const probeVersion = () => 0
  const event = (name, data) => ['p14-probe', probeVersion(), name, data]
  {
    const first = await fresh()
    eq(entityOf(first, visitor.id)?.rank, 0, 'the visitor is a visitor')
    eq(entityOf(first, builder.id)?.rank, 1, 'the builder is a builder')
    eq(entityOf(first, admin.id)?.rank, 2, 'the admin is an admin')
    eq(first.settings.rank ?? 0, 0, 'the world gives nobody a rank')
    eq(first.hasAdminCode, true, 'the world has an admin code')
    ok(blueprintOf(first, 'p14-probe-bp'), 'the probe is installed')
  }
  record(true, 'server up: an admin (by the code), a builder (by modifyRank), a visitor, and the probe app')

  // ---------- any connection ----------

  await run(
    'any-connection',
    'a visitor chats, names itself, moves, sends an app an event and types a command',
    async () => {
      // (also the control of the visitor itself: its packets are read and acted on, so a packet of its that does
      // nothing below did nothing because it was refused)
      let from = admin.mark()
      await send(visitor, 'chatAdded', {
        id: 'forged',
        body: 'P14 a line to keep',
        from: 'admin',
        fromId: admin.id,
        kind: 'system',
      })
      await barrier(admin)
      const line = got(admin, from, 'onChatAdded', data => data.body === 'P14 a line to keep')[0]?.data
      ok(line, 'the line reached another connection')
      eq(line.fromId, visitor.id, 'the server wrote who it is from')
      eq(line.kind, 'player', 'and what kind of line it is')
      // /name, and the fields of its own player
      await send(visitor, 'command', { args: ['name', 'p14-visitor'] })
      await send(visitor, 'entityModified', { id: visitor.id, p: [4, 0, 4], q: [0, 0, 0, 1], t: true })
      // an event for an app script, under an ordinary name
      from = visitor.mark()
      await send(visitor, 'entityEvent', event('probe', { n: 1 }))
      ok(said(visitor, from, 'P14_APP_EVENT {"name":"probe"').length === 1, 'the app took the event')
      // an app line (a client script's world.chat()) and a command that is no command of the server's: the probe is
      // handed the `command` world event, with the id the server gives it
      from = admin.mark()
      await send(visitor, 'appChat', { id: 'p14-probe', body: 'P14 app line', from: 'anyone' })
      await send(visitor, 'command', { args: ['p14-hello', 'world'] })
      await barrier(admin)
      eq(
        got(admin, from, 'onChatAdded', data => data.body === 'P14 app line' && data.kind === 'app').length,
        1,
        'the app line'
      )
      const told = said(admin, from, 'P14_WORLD_EVENT {"name":"command"')[0]?.data.body
      ok(
        told?.includes(`"playerId":"${visitor.id}"`) && told.includes('"args":["p14-hello","world"]'),
        `command event: ${told}`
      )
      const now = await fresh()
      eq(entityOf(now, visitor.id).name, 'p14-visitor', 'its name')
      ok(same(entityOf(now, visitor.id).position, [4, 0, 4]), 'its position')
      ok(
        now.chat.some(msg => msg.body === 'P14 a line to keep'),
        'its line is in the chat a newcomer gets'
      )
      return 'chat, /name, own position, entityEvent, appChat, a command for scripts: all taken from a visitor'
    }
  )

  // ---------- builder ----------

  // A refused packet and its positive control: `low` sends the payload and the state a newcomer is told stays as it
  // was (`unchanged`); then `high` sends the same payload and the state is the new one (`changed`).
  const refusedThenTaken = async ({ low, high, name, payload, logLine, unchanged, changed }) => {
    const from = logFrom()
    await send(low, name, payload)
    unchanged(await fresh())
    if (logLine) await logged(from, logLine)
    await send(high, name, payload)
    changed(await fresh())
  }
  const gateLine = (name, client) => `[network] ${name} from client ${client.id} dropped: builder only`
  // (the server writes an id in a log line as a quoted, shortened value: assetURL.js previewValue)
  const rankLine = (action, client) => `player attempted to ${action} without builder permission: "${client.id}"`

  await run('blueprint-add', "a visitor's blueprintAdded is dropped at the gate; a builder's is stored", async () => {
    await refusedThenTaken({
      low: visitor,
      high: builder,
      name: 'blueprintAdded',
      payload: blueprint('p14-bp'),
      logLine: gateLine('blueprintAdded', visitor),
      unchanged: now => ok(!blueprintOf(now, 'p14-bp'), 'no blueprint from the visitor'),
      changed: now => ok(blueprintOf(now, 'p14-bp'), 'the blueprint from the builder'),
    })
    return 'positive control: the builder'
  })

  await run(
    'blueprint-modify',
    "a visitor's blueprintModified is dropped at the gate; a builder's is applied",
    async () => {
      await refusedThenTaken({
        low: visitor,
        high: builder,
        name: 'blueprintModified',
        payload: { id: 'p14-bp', version: 1, desc: 'P14 changed' },
        logLine: gateLine('blueprintModified', visitor),
        unchanged: now => {
          eq(blueprintOf(now, 'p14-bp').version, 0, 'version')
          eq(blueprintOf(now, 'p14-bp').desc, null, 'desc')
        },
        changed: now => {
          eq(blueprintOf(now, 'p14-bp').version, 1, 'version')
          eq(blueprintOf(now, 'p14-bp').desc, 'P14 changed', 'desc')
        },
      })
      return 'positive control: the builder'
    }
  )

  await run('entity-add', "a visitor's entityAdded is refused and logged; a builder's adds the app", async () => {
    await refusedThenTaken({
      low: visitor,
      high: builder,
      name: 'entityAdded',
      payload: appEntity('p14-app', 'p14-bp'),
      logLine: rankLine('add entity', visitor),
      unchanged: now => ok(!entityOf(now, 'p14-app'), 'no app from the visitor'),
      changed: now => ok(entityOf(now, 'p14-app'), 'the app from the builder'),
    })
    return 'positive control: the builder'
  })

  await run('entity-modify', "a visitor cannot move someone else's app; a builder can", async () => {
    await refusedThenTaken({
      low: visitor,
      high: builder,
      name: 'entityModified',
      payload: { id: 'p14-app', position: [3, 0, 3] },
      logLine: rankLine('modify entity', visitor),
      unchanged: now => ok(same(entityOf(now, 'p14-app').position, [0, 0, 0]), 'where the builder put it'),
      changed: now => ok(same(entityOf(now, 'p14-app').position, [3, 0, 3]), 'moved'),
    })
    return 'positive control: the builder'
  })

  await run('entity-remove', "a visitor cannot remove someone else's app; a builder can", async () => {
    await refusedThenTaken({
      low: visitor,
      high: builder,
      name: 'entityRemoved',
      payload: 'p14-app',
      logLine: rankLine('remove entity', visitor),
      unchanged: now => ok(entityOf(now, 'p14-app'), 'still there'),
      changed: now => ok(!entityOf(now, 'p14-app'), 'removed'),
    })
    return 'positive control: the builder'
  })

  await run('settings', "a visitor cannot change a world setting; a builder can change a builder's", async () => {
    await refusedThenTaken({
      low: visitor,
      high: builder,
      name: 'settingsModified',
      payload: { key: 'title', value: 'P14 title' },
      logLine: rankLine('modify settings', visitor),
      unchanged: now => ok(now.settings.title !== 'P14 title', 'the title'),
      changed: now => eq(now.settings.title, 'P14 title', 'the title'),
    })
    return 'positive control: the builder'
  })

  await run('spawn', 'a visitor cannot set the spawn point, by packet or by /spawn; a builder can', async () => {
    // where a newcomer appears is the spawn point
    const spawnOf = snapshot => entityOf(snapshot, snapshot.id).position
    const start = spawnOf(await fresh())
    const from = logFrom()
    await send(visitor, 'spawnModified', 'set') // the visitor stands at [4, 0, 4] (above)
    await send(visitor, 'command', { args: ['spawn', 'set'] })
    ok(same(spawnOf(await fresh()), start), 'the spawn point is where it was')
    await logged(from, rankLine('modify spawn', visitor))
    await send(builder, 'entityModified', { id: builder.id, p: [9, 0, -9], q: [0, 0, 0, 1], t: true })
    const mark = builder.mark()
    await send(builder, 'spawnModified', 'set')
    await builder.waitFor(m => m.method === 'onChatAdded' && m.data.body === 'Spawn updated', {
      from: mark,
      timeout: wait(10000),
    })
    ok(same(spawnOf(await fresh()), [9, 0, -9]), 'the spawn point is where the builder stood')
    // and back, through the command
    await send(builder, 'command', { args: ['spawn', 'clear'] })
    await builder.waitFor(m => m.method === 'onChatAdded' && m.data.body === 'Spawn cleared', {
      from: mark,
      timeout: wait(10000),
    })
    ok(same(spawnOf(await fresh()), [0, 0, 0]), 'cleared')
    return 'positive control: the builder (packet and /spawn)'
  })

  await run('server-stats', 'a visitor gets no process figures from /server stats; a builder does', async () => {
    const from = visitor.mark()
    await send(visitor, 'command', { args: ['server', 'stats'] })
    // the answer comes after the server has measured for a moment: the builder asks after the visitor did and is
    // answered, by which time a visitor that was going to be answered would have been
    const stats = await builder.serverStats({ timeout: wait(10000) })
    ok(stats.rss > 0, 'the builder is told the memory')
    await sleep(300)
    await barrier(visitor)
    eq(said(visitor, from, 'Memory:').length + said(visitor, from, 'CPU:').length, 0, 'nothing for the visitor')
    return 'positive control: the builder (the server logs nothing for the refusal)'
  })

  await run('ai', "a visitor's ai action is dropped at the gate; a builder's reaches the provider", async () => {
    // the app a create is asked for (ClientAI places one before it asks)
    await send(builder, 'blueprintAdded', blueprint('p14-ai-bp'))
    await send(builder, 'entityAdded', appEntity('p14-ai', 'p14-ai-bp'))
    const action = { name: 'create', blueprintId: 'p14-ai-bp', appId: 'p14-ai', prompt: 'a spinning cube' }
    const from = logFrom()
    await send(visitor, 'ai', action)
    await logged(from, gateLine('ai', visitor))
    await sleep(300)
    eq(mock.ai.length, 0, 'the provider was not asked')
    const mark = admin.mark()
    await send(builder, 'ai', action)
    await logged(from, `[ai] create for "user:${builder.id}"`)
    await admin.waitFor(m => m.method === 'onBlueprintModified' && m.data.id === 'p14-ai-bp' && !!m.data.script, {
      from: mark,
      timeout: wait(30000),
    })
    ok(mock.ai.length >= 1, 'the provider was asked')
    ok(!main.out.includes(`[ai] create for "user:${visitor.id}"`), 'never for the visitor')
    return `positive control: the builder (${mock.ai.length} requests to the mock provider)`
  })

  // ---------- the settings of an admin ----------

  await run(
    'settings-admin',
    "a builder cannot change an admin's setting (rank, customAvatars); an admin can",
    async () => {
      const from = logFrom()
      await send(builder, 'settingsModified', { key: 'rank', value: 1 })
      await send(builder, 'settingsModified', { key: 'customAvatars', value: true })
      await send(visitor, 'settingsModified', { key: 'rank', value: 1 })
      let now = await fresh()
      eq(now.settings.rank ?? 0, 0, 'the rank the world gives everyone')
      ok(!now.settings.customAvatars, 'custom avatars')
      await logged(from, 'player attempted to modify setting without admin permission')
      await send(admin, 'settingsModified', { key: 'rank', value: 1 })
      await send(admin, 'settingsModified', { key: 'customAvatars', value: true })
      now = await fresh()
      eq(now.settings.rank, 1, 'the rank, from the admin')
      eq(now.settings.customAvatars, true, 'custom avatars, from the admin')
      await send(admin, 'settingsModified', { key: 'rank', value: 0 })
      await send(admin, 'settingsModified', { key: 'customAvatars', value: false })
      now = await fresh()
      eq(now.settings.rank, 0, 'back')
      eq(now.settings.customAvatars, false, 'back')
      return 'positive control: the admin, both keys'
    }
  )

  // ---------- what the world's settings change ----------

  await run(
    'world-rank',
    'where the world makes everyone a builder, a visitor builds; back at visitor, it does not',
    async () => {
      await send(visitor, 'entityAdded', appEntity('p14-free-1', 'p14-bp'))
      ok(!entityOf(await fresh(), 'p14-free-1'), 'refused while the world gives no rank')
      await send(admin, 'settingsModified', { key: 'rank', value: 1 })
      await send(visitor, 'entityAdded', appEntity('p14-free-1', 'p14-bp'))
      let now = await fresh()
      ok(entityOf(now, 'p14-free-1'), 'taken while the world makes everyone a builder')
      eq(entityOf(now, visitor.id).rank, 0, "the visitor's own rank is still visitor")
      await send(admin, 'settingsModified', { key: 'rank', value: 0 })
      await send(visitor, 'entityAdded', appEntity('p14-free-2', 'p14-bp'))
      await send(visitor, 'entityRemoved', 'p14-free-1')
      now = await fresh()
      ok(!entityOf(now, 'p14-free-2'), 'refused again')
      ok(entityOf(now, 'p14-free-1'), 'and what it built it can no longer remove')
      return 'positive control: the same visitor and payload, with settings.rank = builder'
    }
  )

  await run('world-avatars', "a visitor's stored avatar: refused, and taken where Custom Avatars is on", async () => {
    const change = { id: visitor.id, avatar: 'asset://p14-avatar.vrm' }
    const before = entityOf(await fresh(), visitor.id).avatar
    await send(visitor, 'entityModified', change)
    eq(entityOf(await fresh(), visitor.id).avatar, before, 'the avatar it had')
    await send(admin, 'settingsModified', { key: 'customAvatars', value: true })
    await send(visitor, 'entityModified', change)
    eq(entityOf(await fresh(), visitor.id).avatar, 'asset://p14-avatar.vrm', 'the avatar it asked for')
    await send(admin, 'settingsModified', { key: 'customAvatars', value: false })
    return 'positive control: the same visitor and payload, with settings.customAvatars on'
  })

  // ---------- admin ----------

  const target = await connect('target')

  await run(
    'modify-rank',
    "nobody but an admin changes a rank: not its own, not the admin's, not a third player's",
    async () => {
      const give = { playerId: target.id, rank: 1 }
      await send(visitor, 'modifyRank', give)
      await send(visitor, 'modifyRank', { playerId: visitor.id, rank: 2 })
      await send(visitor, 'modifyRank', { playerId: admin.id, rank: 0 })
      await send(builder, 'modifyRank', give)
      await send(builder, 'modifyRank', { playerId: builder.id, rank: 2 })
      await send(builder, 'modifyRank', { playerId: admin.id, rank: 0 })
      let now = await fresh()
      eq(entityOf(now, target.id).rank, 0, 'the third player')
      eq(entityOf(now, visitor.id).rank, 0, 'the visitor')
      eq(entityOf(now, builder.id).rank, 1, 'the builder')
      eq(entityOf(now, admin.id).rank, 2, 'the admin')
      await send(admin, 'modifyRank', give)
      now = await fresh()
      eq(entityOf(now, target.id).rank, 1, 'the third player, from the admin')
      await send(admin, 'modifyRank', { playerId: target.id, rank: 0 })
      eq(entityOf(await fresh(), target.id).rank, 0, 'and back')
      return 'positive control: the admin (the server logs nothing for the refusals)'
    }
  )

  // ---------- kick and mute: the sender has to outrank the target ----------

  await run(
    'mute',
    "a mute needs a rank above the target's: visitor on visitor, on builder, builder on admin are refused",
    async () => {
      await send(visitor, 'mute', { playerId: target.id, muted: true })
      await send(visitor, 'mute', { playerId: builder.id, muted: true })
      await send(visitor, 'mute', { playerId: admin.id, muted: true })
      await send(builder, 'mute', { playerId: admin.id, muted: true })
      await send(builder, 'mute', { playerId: builder.id, muted: true })
      await send(admin, 'mute', { playerId: admin.id, muted: true })
      let now = await fresh()
      ok(now.livekit, 'the snapshot carries the voice state')
      ok(same(muted(now), []), `nobody is muted: ${JSON.stringify(muted(now))}`)
      await send(builder, 'mute', { playerId: target.id, muted: true })
      await send(admin, 'mute', { playerId: builder.id, muted: true })
      now = await fresh()
      ok(
        same(muted(now).sort(), [target.id, builder.id].sort()),
        `a builder muted a visitor, the admin a builder: ${JSON.stringify(muted(now))}`
      )
      // a muted player cannot unmute itself, and a visitor cannot unmute anyone
      await send(target, 'mute', { playerId: target.id, muted: false })
      await send(visitor, 'mute', { playerId: builder.id, muted: false })
      eq(muted(await fresh()).length, 2, 'still muted')
      await send(admin, 'mute', { playerId: target.id, muted: false })
      await send(admin, 'mute', { playerId: builder.id, muted: false })
      ok(same(muted(await fresh()), []), 'unmuted by the admin')
      return 'positive control: the builder on a visitor, the admin on the builder (the server logs nothing for the refusals)'
    }
  )

  await run('kick', "a kick needs a rank above the target's; a builder kicks a visitor", async () => {
    await send(visitor, 'kick', target.id)
    await send(visitor, 'kick', builder.id)
    await send(visitor, 'kick', admin.id)
    await send(builder, 'kick', admin.id)
    await send(builder, 'kick', builder.id)
    await send(builder, 'kick', 'p14-probe') // an app has no rank to outrank
    // each of them is still here: it answers a ping, and a newcomer is told of it
    for (const client of [target, builder, admin]) await barrier(client)
    let now = await fresh()
    for (const client of [target, builder, admin, visitor]) ok(entityOf(now, client.id), `${client.label} is here`)
    eq(main.lines(/\[network\] \S+ kicked /).length, 0, 'no kick is in the log')
    const from = logFrom()
    builder.send('kick', target.id)
    eq(
      (await Promise.race([target.closed, sleep(wait(10000)).then(() => 'open')])) !== 'open',
      true,
      'the visitor is closed'
    )
    ok(
      target.inbox.some(m => m.method === 'onKick' && m.data === 'moderation'),
      'and was told why'
    )
    await logged(from, `[network] "${builder.id}" kicked "${target.id}"`)
    now = await fresh()
    ok(!entityOf(now, target.id), 'and is gone')
    return 'positive control: the builder on a visitor'
  })

  // ---------- what the holder of an app may still do ----------

  await run(
    'holder',
    'a builder that lost its rank may let go of its own move and upload, and nothing else',
    async () => {
      const holder = await connect('holder')
      await rank(holder, 1)
      await send(holder, 'entityAdded', appEntity('p14-held', 'p14-bp', { position: [1, 0, 1] }))
      await send(holder, 'entityAdded', appEntity('p14-upload', 'p14-bp', { uploader: holder.id }))
      await send(holder, 'entityModified', { id: 'p14-held', mover: holder.id })
      let now = await fresh()
      eq(entityOf(now, 'p14-held')?.mover, holder.id, 'the builder is moving one app')
      eq(entityOf(now, 'p14-upload')?.uploader, holder.id, 'and uploading another')
      // someone who holds neither: the same packets do nothing
      const release = { id: 'p14-held', mover: null, position: [5, 0, 5], scale: [2, 2, 2] }
      await send(visitor, 'entityModified', release)
      await send(visitor, 'entityRemoved', 'p14-upload')
      now = await fresh()
      eq(entityOf(now, 'p14-held').mover, holder.id, 'the move is not ended by a visitor')
      ok(entityOf(now, 'p14-upload'), 'the upload is not removed by a visitor')
      // the holder, a visitor from here on
      await rank(holder, 0)
      await send(holder, 'entityModified', release)
      now = await fresh()
      eq(entityOf(now, 'p14-held').mover, null, 'its own move is ended')
      ok(
        same(entityOf(now, 'p14-held').position, [1, 0, 1]),
        'and the app is where it was: the position it sent along was not taken'
      )
      ok(same(entityOf(now, 'p14-held').scale, [1, 1, 1]), 'nor the scale')
      await send(holder, 'entityRemoved', 'p14-upload')
      // with the holds gone it is a visitor like any other
      await send(holder, 'entityModified', { id: 'p14-held', position: [6, 0, 6] })
      await send(holder, 'entityModified', { id: 'p14-held', mover: holder.id })
      await send(holder, 'entityRemoved', 'p14-held')
      now = await fresh()
      ok(!entityOf(now, 'p14-upload'), 'its own pending upload is removed')
      ok(entityOf(now, 'p14-held'), 'the app it no longer holds is not')
      ok(same(entityOf(now, 'p14-held').position, [1, 0, 1]), 'nor moved')
      eq(entityOf(now, 'p14-held').mover, null, 'nor taken again')
      await close(holder)
      return 'positive control: the holder itself (a visitor that holds nothing sent the same packets first)'
    }
  )

  // ---------- refused whoever sends it ----------

  const other = await connect('other')

  await run(
    'other-player',
    "another player's fields are not changed and a player is not removed, by anyone",
    async () => {
      const before = entityOf(await fresh(), other.id)
      const change = { id: other.id, name: 'p14-renamed-by-someone', p: [50, 0, 50], q: [0, 0, 0, 1], t: true }
      const from = logFrom()
      await send(visitor, 'entityModified', change)
      await logged(from, 'player attempted to modify another player')
      await send(visitor, 'entityRemoved', other.id)
      await logged(from, 'player attempted to remove a non-app entity')
      // an admin is refused as a visitor is (each connection's first refusal is logged)
      await send(admin, 'entityModified', change)
      await send(admin, 'entityRemoved', other.id)
      await waitUntil(() => main.out.slice(from).split('player attempted to modify another player').length - 1 === 2, {
        message: "the line for the admin's packet",
      })
      await barrier(other)
      let now = await fresh()
      eq(entityOf(now, other.id)?.name, before.name, 'the name')
      ok(same(entityOf(now, other.id).position, before.position), 'the position')
      // the same change by the player itself
      await send(other, 'entityModified', change)
      now = await fresh()
      eq(entityOf(now, other.id).name, 'p14-renamed-by-someone', 'the name, changed by its owner')
      ok(same(entityOf(now, other.id).position, [50, 0, 50]), 'the position, changed by its owner')
      return `${NONE} by rank: refused for the admin too. The control is the player itself, whose same payload is taken`
    }
  )

  await run(
    'internal-events',
    'an entityEvent named tip, evmWallet or command reaches no script, from anyone',
    async () => {
      const fromVisitor = visitor.mark()
      const forged = {
        tip: { tipId: 'forged', fromPlayerId: visitor.id, toPlayerId: admin.id, token: 'JPYC', amount: '1000000' },
        evmWallet: { playerId: visitor.id, verified: true },
        command: { playerId: admin.id, args: ['forged'] },
      }
      for (const name of REFUSED_EVENT_NAMES) {
        await send(visitor, 'entityEvent', event(name, forged[name]))
        await send(admin, 'entityEvent', event(name, forged[name]))
      }
      await barrier(visitor)
      eq(said(visitor, fromVisitor, 'P14_APP_EVENT').length, 0, 'no app listener was called')
      eq(said(visitor, fromVisitor, 'P14_WORLD_EVENT').length, 0, 'no world listener was called')
      // the same app, the same connection, the same payload, an ordinary name
      await send(visitor, 'entityEvent', event('probe', forged.tip))
      eq(said(visitor, fromVisitor, 'P14_APP_EVENT {"name":"probe"').length, 1, 'the probe takes an ordinary event')
      return `${NONE} by rank: refused for the admin too. The control is the same payload under a name that is not internal (the server logs nothing for the refusals)`
    }
  )

  // a line of chat for the cases that ask whether the chat is still there (the chat keeps its last 50 lines, so
  // each of them writes its own)
  const chatLine = async text => {
    await send(visitor, 'chatAdded', { body: text })
    ok(
      (await fresh()).chat.some(msg => msg.body === text),
      'the line is in the chat'
    )
    return text
  }

  // ---------- names the server has no handler for ----------

  await run('no-handler', 'a server-to-client packet sent by a client does nothing', async () => {
    const payloads = {
      snapshot: { id: admin.id, settings: { rank: 2 }, entities: [], blueprints: [], chat: [] },
      chatCleared: null,
      liveKitLevel: { playerId: other.id, level: 'disabled' },
      pong: 'p14-forged-pong',
      builderNonce: { attempt: 1, nonce: 'a'.repeat(64), message: 'sign this' },
      walletStatus: { verified: true, wallet: '11111111111111111111111111111111' },
      tokenBalance: { id: 1, verified: true, known: true, balance: 1e9 },
      evmNonce: { attempt: 1, nonce: 'a'.repeat(64), message: 'sign this' },
      evmWalletStatus: { verified: true, wallet: `0x${'1'.repeat(40)}` },
      evmTipIntent: { id: 1, ok: true },
      evmTipStatus: { ticket: '0'.repeat(32), txHash: `0x${'1'.repeat(64)}`, state: 'confirmed' },
    }
    const line = await chatLine('P14 a line before the forged packets')
    const names = namesOfClass('no-handler')
    ok(same([...names].sort(), Object.keys(payloads).sort()), `a payload for every such name: ${names.join(', ')}`)
    const methods = names.map(name => `on${name[0].toUpperCase()}${name.slice(1)}`)
    const marks = [admin, other, builder].map(client => [client, client.mark()])
    for (const sender of [visitor, admin]) for (const name of names) await send(sender, name, payloads[name])
    for (const [client, from] of marks) {
      await barrier(client)
      // (a pong is what each barrier is answered with: only the forged one would be news)
      const news = client
        .since(from)
        .filter(m => methods.includes(m.method) && !(m.method === 'onPong' && m.data !== 'p14-forged-pong'))
      eq(news.length, 0, `${client.label} was told nothing: ${JSON.stringify(news.slice(0, 2))}`)
    }
    ok(visitor.isOpen && admin.isOpen, 'the senders are still connected')
    const now = await fresh()
    ok(
      now.chat.some(msg => msg.body === line),
      'the chat was not cleared'
    )
    eq(now.settings.rank, 0, 'the settings are as they were')
    return `${NONE}: the server has no handler for ${names.length} names, for any sender (and logs nothing)`
  })

  await run('chat-clear', 'a visitor cannot clear the chat with /chat clear; a builder can', async () => {
    const line = await chatLine('P14 a line before the clear')
    const from = admin.mark()
    await send(visitor, 'command', { args: ['chat', 'clear'] })
    await barrier(admin)
    eq(got(admin, from, 'onChatCleared').length, 0, 'nobody was told the chat was cleared')
    ok(
      (await fresh()).chat.some(msg => msg.body === line),
      'the chat is as it was'
    )
    await send(builder, 'command', { args: ['chat', 'clear'] })
    await barrier(admin)
    eq(got(admin, from, 'onChatCleared').length, 1, 'everyone was told')
    ok(!(await fresh()).chat.some(msg => msg.body === line), 'the chat is cleared')
    return 'positive control: the builder (the server logs nothing for the refusal)'
  })

  // ---------- the wallet flows, in a world that has none ----------

  const SOL_WALLET = '11111111111111111111111111111111'
  const EVM_WALLET = `0x${'12'.repeat(20)}`
  const walletPackets = () => ({
    requestBuilderNonce: { walletAddress: SOL_WALLET, attempt: 1 },
    requestBuilderByToken: { walletAddress: SOL_WALLET, signature: 'x', nonce: 'a'.repeat(64), attempt: 1 },
    requestBuilderRecheck: {},
    tokenBalanceRequest: { id: 2 },
    revokeBuilderByToken: {},
    requestEvmNonce: { address: EVM_WALLET, attempt: 3 },
    requestEvmVerify: { address: EVM_WALLET, signature: `0x${'1'.repeat(130)}`, nonce: 'a'.repeat(64), attempt: 3 },
    revokeEvmWallet: {},
    setEvmTipReceive: { enabled: true },
    requestEvmTipIntent: { id: 4, to: 'nobody', token: 'JPYC', amount: '1' },
    evmTip: { ticket: '0'.repeat(32), txHash: `0x${'1'.repeat(64)}` },
  })
  const WALLET_ANSWERS = [
    'onBuilderNonce',
    'onWalletStatus',
    'onTokenBalance',
    'onEvmNonce',
    'onEvmWalletStatus',
    'onEvmTipIntent',
    'onEvmTipStatus',
  ]
  ok(same(Object.keys(walletPackets()).sort(), namesOfClass('feature').sort()), 'a payload for every wallet packet')

  await run('wallet', 'in a world without the wallet features, every wallet packet is ignored', async () => {
    const from = visitor.mark()
    for (const [name, payload] of Object.entries(walletPackets())) await send(visitor, name, payload)
    const answers = visitor.since(from).filter(m => WALLET_ANSWERS.includes(m.method) || m.method === 'onChatAdded')
    eq(answers.length, 0, `nothing is answered: ${JSON.stringify(answers.slice(0, 2))}`)
    const now = await fresh()
    eq(entityOf(now, visitor.id).rank, 0, 'no rank')
    ok(!entityOf(now, visitor.id).evmTips, 'no tips switch')
    return 'the positive control is the second server, where the same payloads are answered (below)'
  })

  // ---------- identity ----------

  await run(
    'identity',
    'a forged session token, and one for a user that does not exist, connect as someone new',
    async () => {
      const JWT = SECRETS.JWT_SECRET.value
      ok(verifies(admin.authToken, JWT), 'the control of the forgery: a real token verifies under the secret')
      eq(tokenPayload(admin.authToken).userId, admin.id, "and names the admin's user")
      const check = async (label, authToken, victim) => {
        const client = await connect(label, { authToken })
        ok(client.id !== victim, `${label}: not the user the token names`)
        eq(entityOf(client.snapshot, client.id).rank, 0, `${label}: a visitor`)
        eq(tokenPayload(client.authToken).userId, client.id, `${label}: given a token for the new user`)
        ok(client.authToken !== authToken, `${label}: the token it brought is not given back`)
        await close(client)
        return client.id
      }
      // the admin's own token, its signature made with another secret
      const [head, body] = admin.authToken.split('.')
      await check(
        'forged-signature',
        `${head}.${body}.${hmac(`${head}.${body}`, 'not-the-secret-of-this-server')}`,
        admin.id
      )
      // a token the server would have signed itself, for a user it has no row for
      const ghost = 'p14-no-such-user'
      await check('unknown-user', signToken(sessionPayload(ghost), JWT), ghost)
      ok(admin.isOpen, 'the admin is still connected')
      eq(entityOf(await fresh(), admin.id).rank, 2, 'and still the only one with its id')
      // the controls: a real token joins as its user, and so does one signed with the previous secret (which is
      // also what shows that the server reads JWT_SECRET_PREVIOUS)
      await close(other)
      await sleep(300)
      const back = await connect('other-again', { authToken: other.authToken })
      eq(back.id, other.id, 'a real token joins as its user')
      await close(back)
      await sleep(300)
      const rotated = await connect('other-rotated', {
        authToken: signToken(sessionPayload(other.id), SECRETS.JWT_SECRET_PREVIOUS.value),
      })
      eq(rotated.id, other.id, 'a token signed with the previous secret joins as its user')
      ok(verifies(rotated.authToken, JWT), 'and is given one signed with the current secret')
      await close(rotated)
      return 'positive control: the real token of a user, and one signed with JWT_SECRET_PREVIOUS'
    }
  )

  // ---------- /admin with a wrong code (last: wrong codes slow this address down for minutes) ----------

  await run(
    'admin-code',
    'a wrong admin code gives no rank, is answered to its sender, and ends with the socket closed',
    async () => {
      const WRONG = 'Wrong admin code.'
      const WAIT = 'Too many attempts. Try again later.'
      const guesser = await connect('guesser')
      const count = (client, body) =>
        client.inbox.filter(m => m.method === 'onChatAdded' && m.data.body === body).length
      const from = admin.mark()
      await send(guesser, 'command', { args: ['admin', 'p14-guess-0'] })
      eq(count(guesser, WRONG), 1, 'told that the code is wrong')
      eq(entityOf(await fresh(), guesser.id).rank, 0, 'no rank')
      // the first three wrong codes of an address are read; from then on the address waits, and its attempts are
      // refused unread. The socket that keeps trying is closed at its 21st attempt.
      const flooded = Date.now()
      for (let i = 1; i < 21; i++) guesser.send('command', { args: ['admin', `p14-guess-${i}`] })
      const closed = await Promise.race([guesser.closed, sleep(wait(10000)).then(() => 'open')])
      ok(closed !== 'open', 'the socket is closed')
      ok(
        guesser.inbox.some(m => m.method === 'onKick' && m.data === 'admin_attempts'),
        'and was told why'
      )
      eq(count(guesser, WRONG), 3, 'three codes were read')
      ok(count(guesser, WAIT) >= 1, 'then the address waits')
      ok(!guesser.inbox.some(m => m.method === 'onEntityModified' && m.data.rank > 0), 'never a rank')
      // The wait is the address's: the right code from a new connection is refused during it. The first wait is 10
      // seconds from the third wrong code (adminCode.js); a machine so slow that most of it has gone by before the
      // new connection is ready does not ask this (test/adminCode.test.js asks it with a clock of its own).
      let late = null
      let lateNote = ''
      const waited = Date.now() - flooded
      if (waited < 6000) {
        late = await connect('late')
        await send(late, 'command', { args: ['admin', CODE] })
        eq(count(late, WAIT), 1, 'the right code is refused while the address waits')
        ok(!late.inbox.some(m => m.method === 'onEntityModified' && m.data.rank > 0), 'no rank for it')
      } else {
        lateNote = ` (the right code during the wait was not tried: ${waited} ms had passed)`
      }
      eq(main.count('p14-guess-'), 0, 'no candidate is in the server log')
      await barrier(admin)
      eq(
        got(admin, from, 'onChatAdded', data => data.body === WRONG || data.body === WAIT).length,
        0,
        'the answers went to nobody else'
      )
      const now = await fresh()
      if (late) eq(entityOf(now, late.id).rank, 0, 'no rank for the late one')
      eq(
        now.entities.filter(entity => entity.type === 'player' && entity.rank === 2).length,
        1,
        'the admin of this run is the only admin here'
      )
      if (late) await close(late)
      return `positive control: the right code made the admin of this run, before any wrong one${lateNote}`
    }
  )

  // ---------- secrets ----------

  const fetchText = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(wait(10000)) })
    const headers = [...response.headers].map(([key, value]) => `${key}: ${value}`).join('\n')
    return { status: response.status, body: await response.text(), headers }
  }
  // what /env.js sets `globalThis.env` to (its last assignment; the one before it is the empty default)
  const servedEnv = text => JSON.parse([...text.matchAll(/globalThis\.env = (\{.*\})\s*$/gm)].at(-1)[1])
  // the surfaces of one server -> { findings, texts }
  const surfaces = async (origin, server, connections, joins) => {
    const findings = []
    const texts = {}
    for (const route of ['/', '/env.js', '/status', '/health']) {
      const { status, body, headers } = await fetchText(`${origin}${route}`)
      eq(status, 200, route)
      texts[route] = body
      findings.push(...search(route, `${headers}\n${body}`))
    }
    for (const [label, client] of Object.entries(joins)) {
      // the join snapshot: its bytes as they came, and every string of what they decode to
      eq(client.raw.length > 0 && client.inbox[0]?.method, 'onSnapshot', `${label}: the first packet is the snapshot`)
      const bytes = client.raw[0].toString('latin1')
      texts[label] = `${bytes}\n${strings(client.snapshot).join('\n')}`
      findings.push(...search(label, texts[label]))
    }
    let packets = 0
    for (const client of connections) {
      for (const raw of client.raw)
        findings.push(...search(`a packet ${client.label} received`, raw.toString('latin1')))
      for (const message of client.inbox)
        findings.push(...search(`a packet ${client.label} received`, strings(message.data).join('\n')))
      packets += client.raw.length
    }
    findings.push(...search('the server log', server.out))
    return { findings: [...new Set(findings)], texts, packets }
  }

  await run(
    'secrets',
    'no secret of the server is in the page, /env.js, /status, /health, a join snapshot, a packet or the log',
    async () => {
      // every name the table calls a secret is set to a sentinel here, or said not to be
      const secrets = envNamesOf('secret').map(name => (name.endsWith('*') ? name.replace('*', '137') : name))
      ok(
        same([...Object.keys(SECRETS), ...Object.keys(NOT_PLANTED)].sort(), secrets.sort()),
        `every secret of envTable.mjs: ${secrets.join(', ')}`
      )
      for (const name of SERVED_ENV_NAMES) eq(ENV_TABLE[name].class, 'public', name)

      const visitorJoin = await connect('visitor-join')
      await close(visitorJoin)
      const { findings, texts, packets } = await surfaces(base, main, w.clients, {
        "a visitor's join snapshot": visitorJoin,
        "an admin's join snapshot": adminJoin,
      })
      eq(findings.length, 0, findings.join('; '))

      // the controls of the search: it finds what is there
      ok(texts['/env.js'].includes(PUBLIC_MARKER), 'a listed PUBLIC_ value is in /env.js')
      ok(texts['/status'].includes(COMMIT_MARKER), 'COMMIT_HASH is in /status')
      for (const [label, text] of Object.entries(texts)) {
        if (!label.includes('snapshot')) continue
        ok(!text.includes(LIVEKIT_KEY), `${label}: the voice key is not there as text`)
        ok(
          readings(text).some(reading => reading.includes(`"iss":"${LIVEKIT_KEY}"`)),
          `${label}: and is found by decoding the voice token`
        )
      }
      eq(search('control', `x ${b64u(`{"k":"${SECRETS.ADMIN_CODE.value}"}`)} y`).length > 0, true, 'base64 is decoded')
      eq(search('control', `x.${b64u(b64u(SECRETS.AI_API_KEY.value))}`).length > 0, true, 'two levels deep')
      eq(
        search('control', encodeURIComponent(SECRETS.ASSETS_S3_URI.value)).length > 0,
        true,
        'percent escapes are decoded'
      )

      // /env.js is the served names that are set, and nothing else
      const served = servedEnv(texts['/env.js'])
      ok(
        Object.keys(served).every(name => SERVED_ENV_NAMES.includes(name)),
        `only served names: ${Object.keys(served).join(', ')}`
      )
      ok(!(UNLISTED.name in served) && !('PUBLIC_RPC_URL' in served), 'no other PUBLIC_ name')
      eq(served.PUBLIC_WS_URL, `ws://localhost:${PORT}/ws`, 'the page still gets where to connect')
      // the three it serves as before (the harness sets them: lib/server.mjs serverEnv)
      eq(served.PUBLIC_API_URL, `http://localhost:${PORT}/api`, 'PUBLIC_API_URL, as before')
      eq(served.PUBLIC_MAX_UPLOAD_SIZE, '12', 'PUBLIC_MAX_UPLOAD_SIZE, as before')
      eq(served.PUBLIC_TOKEN_DECIMALS, '6', 'PUBLIC_TOKEN_DECIMALS, as before')
      ok(
        SERVED_AS_BEFORE_ENV_NAMES.every(name => name in served),
        'every name served as before'
      )
      // the PUBLIC_ name nothing reads is named once at start-up, without its value; the RPC fallback, which is
      // set, is not named
      eq(main.count(`[envs] not handed to the page (/env.js): ${UNLISTED.name}.`), 1, 'named once in the start log')
      eq(main.count('PUBLIC_RPC_URL'), 0, 'PUBLIC_RPC_URL is left out without a word')

      // each sentinel is a value the server uses (where the run can show it)
      ok(verifies(visitorJoin.authToken, SECRETS.JWT_SECRET.value), `JWT_SECRET: ${SECRETS.JWT_SECRET.live}`)
      ok(
        verifies(visitorJoin.snapshot.livekit.token, SECRETS.LIVEKIT_API_SECRET.value),
        `LIVEKIT_API_SECRET: ${SECRETS.LIVEKIT_API_SECRET.live}`
      )
      ok(
        mock.ai.length > 0 && mock.ai.every(request => request.key === SECRETS.AI_API_KEY.value),
        `AI_API_KEY: ${SECRETS.AI_API_KEY.live}`
      )
      // (ADMIN_CODE made the admin, and JWT_SECRET_PREVIOUS was accepted in [identity])
      const unshown = Object.entries(SECRETS)
        .filter(([, secret]) => !secret.live)
        .map(([name]) => name)
      return `${packets} packets and ${main.out.length} bytes of log searched; set but not used in this run, so only shown absent: ${unshown.join(', ')}; not set: ${Object.keys(NOT_PLANTED).join(', ')}`
    }
  )

  await step('the server handled every packet of the run without an error of its own', async () => {
    const lines = main.lines(/\] \w+ from client \S+ failed:|UnhandledPromiseRejection|SES_UNHANDLED|decoder bug/)
    eq(lines.length, 0, lines.slice(0, 3).join(' | '))
  })

  for (const client of w.clients) client.close()
  await main.stop()
  main = null

  // ====================================================================================================
  // the second server: the same secrets, in a world with the token gate, EVM sign-in and tips
  // ====================================================================================================
  second = await startServer({
    port: PORT + 1,
    env: walletEnv,
    logPath: path.join(OUT, 'access-control-wallet-server.log'),
  })
  const w2 = world(second)
  const origin = `http://localhost:${PORT + 1}`

  await run('wallet', 'in a world with the wallet features, the same packets from a visitor are answered', async () => {
    const guest = await w2.connect('guest')
    const from = guest.mark()
    const packets = walletPackets()
    for (const name of ['requestBuilderNonce', 'tokenBalanceRequest', 'requestEvmNonce', 'requestEvmTipIntent']) {
      await w2.send(guest, name, packets[name])
    }
    const answer = method => got(guest, from, method)[0]?.data
    eq(answer('onBuilderNonce')?.attempt, 1, 'a sign-in message for the token gate')
    ok(/^[a-f0-9]{64}$/.test(answer('onBuilderNonce').nonce), 'with a nonce')
    eq(answer('onTokenBalance')?.verified, false, 'a balance answer (no wallet is verified)')
    eq(answer('onEvmNonce')?.attempt, 3, 'an EVM sign-in message')
    eq(
      answer('onEvmTipIntent')?.reason,
      'not_verified',
      'a tip intent is answered (and refused: no wallet is verified)'
    )
    return 'the positive control of [wallet]: the feature decides, not the rank'
  })

  await run(
    'secrets-wallet-world',
    'no secret is in the same surfaces of a world with the wallet features on',
    async () => {
      const adminJoin2 = await (async () => {
        const first = await w2.connect('admin-join')
        await first.becomeAdmin(SECRETS.ADMIN_CODE.value)
        await w2.close(first)
        await sleep(300)
        const again = await w2.connect('admin-join', { authToken: first.authToken })
        eq(entityOf(again.snapshot, again.id)?.rank, 2, 'joined as an admin')
        return again
      })()
      const visitorJoin = await w2.connect('visitor-join')
      const { findings, texts, packets } = await surfaces(origin, second, w2.clients, {
        "a visitor's join snapshot": visitorJoin,
        "an admin's join snapshot": adminJoin2,
      })
      eq(findings.length, 0, findings.join('; '))
      const served = servedEnv(texts['/env.js'])
      eq(served.PUBLIC_TOKEN_MINT, SOL_MINT, 'the mint is public')
      eq(served.PUBLIC_EVM_CHAIN_IDS, '137', 'the chain ids are public')
      eq(served.PUBLIC_EVM_TIP_TOKENS, 'JPYC', 'the tip tokens are public')
      ok(
        Object.keys(served).every(name => SERVED_ENV_NAMES.includes(name)),
        'only served names'
      )
      ok(second.out.includes('[envs] player.getEvmHolding() asks only about'), 'EVM is on in this world')
      return `${packets} packets and ${second.out.length} bytes of log searched (${mock.rpc.length} requests reached the mock RPC)`
    }
  )

  for (const client of w2.clients) client.close()

  // every case the tables name ran, and every case that ran is named there
  await step('every case the rules name ran, and passed', async () => {
    const named = namedCases()
    const missing = named.filter(id => !ran.has(id))
    const failed = named.filter(id => ran.get(id) === false)
    const unnamed = [...ran.keys()].filter(id => !named.includes(id))
    eq(missing.length, 0, `not run: ${missing.join(', ')}`)
    eq(unnamed.length, 0, `run and not named in test/lib/packetAccess.mjs: ${unnamed.join(', ')}`)
    eq(failed.length, 0, `failed: ${failed.join(', ')}`)
    return `${named.length} cases for ${Object.keys(PACKET_RULES).length} packet names`
  })
} catch (err) {
  record(false, 'aborted', err?.stack || String(err))
} finally {
  await main?.stop().catch(() => {})
  await second?.stop().catch(() => {})
  mockServer.closeAllConnections()
  await new Promise(resolve => mockServer.close(resolve))
  process.exit(finish() ? 1 : 0)
}
