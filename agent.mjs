import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createNodeClientWorld } from './build/world-node-client.js'
import { agentId, logText, saveTokenFile, tokenFileOf } from './scripts/lib/agentFiles.mjs'

// coo-world AI エージェント runtime (node-client)
//
// - 設定は環境変数から (WS_URL / AGENT_ID / AGENT_NAME / AGENT_AVATAR)
// - authToken を per-instance ファイルに保存し、同一マシンで複数体を衝突なく起動可能
//   (ClientNetwork.init の authToken/onAuthToken 経路を使用)
// - 切断時は指数 backoff で再接続。kick 理由で分岐 (moderation/kicked/duplicate_user/outdated は再試行しない)
// - perceive(チャット/近傍プレイヤー) -> decide(差し替え可能) -> act のループ
//
// 実運用では createBehavior() を LLM 駆動のポリシーに差し替える。

const dirname = path.dirname(fileURLToPath(import.meta.url))

// --- config ---
const WS_URL = process.env.WS_URL || process.env.PUBLIC_WS_URL || 'ws://localhost:3000/ws'
const AGENT_ID = agentId(process.env.AGENT_ID)
if (AGENT_ID === null) {
  // (it names the token file: scripts/lib/agentFiles.mjs)
  console.error('[agent] AGENT_ID must be 1 to 64 letters, digits, _ or -')
  process.exit(1)
}
const AGENT_NAME = process.env.AGENT_NAME || undefined
// an asset://<name>.vrm of the world, or an http(s) url: the server takes a url outside the world only when the
// agent's user is a builder there (otherwise the agent wears the world's default avatar)
const AGENT_AVATAR = process.env.AGENT_AVATAR || undefined
const TICK_MS = Number(process.env.AGENT_TICK_MS) || 300
const MAX_BACKOFF = 30000

// --- per-instance auth token 永続化 (N体同時起動 + 再起動をまたぐ同一性) ---
const tokenFile = tokenFileOf(dirname, AGENT_ID)
function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8')).authToken || null
  } catch {
    return null
  }
}
// The token of the last snapshot, kept in memory as well: the server replaces a token that is more than a day old,
// and the one it replaced ends 180 days after it was made. If writing the new one to disk fails, a reconnect that
// read the file again would present the old token, and after its end the agent would be a new visitor, without its
// stored rank.
let latestToken = null
function saveToken(token) {
  latestToken = token
  try {
    // (readable by its owner only: the token is this agent's identity and rank in the world)
    saveTokenFile(tokenFile, token)
  } catch (err) {
    console.error(`[agent ${AGENT_ID}] token save failed:`, err?.message || err)
  }
}

// --- perceive: ワールド状態のスナップショット ---
function perceive(world) {
  const me = world.entities.player
  const others = []
  world.entities.players?.forEach(p => {
    if (me && p.data.id === me.data.id) return
    others.push({ id: p.data.id, name: p.data.name })
  })
  return {
    self: me ? { id: me.data.id, name: me.data.name } : null,
    playerCount: others.length,
    players: others,
  }
}

// --- decide: 差し替え可能な行動ポリシー。デフォルトはランダム歩行 + 一度だけ挨拶 ---
function createBehavior() {
  const keys = ['keyW', 'keyA', 'keyS', 'keyD', 'space', 'shiftLeft']
  let greeted = false
  let ticks = 0
  return function decide() {
    ticks++
    const actions = []
    const key = keys[Math.floor(Math.random() * keys.length)]
    actions.push({ type: 'button', key, down: Math.random() < 0.5 })
    if (!greeted && ticks * TICK_MS > 2000) {
      greeted = true
      actions.push({ type: 'chat', text: 'heyo...' })
    }
    return actions
  }
}

// --- act: decide が返したアクションを実行 ---
function act(world, actions) {
  for (const a of actions) {
    if (a.type === 'button') {
      console.log(`${a.down ? 'press' : 'release'}: ${a.key}`)
      world.controls.simulateButton(a.key, a.down)
    } else if (a.type === 'chat' && a.text) {
      world.chat.send(a.text)
    }
  }
}

// --- runtime ---
const decide = createBehavior()
let stopped = false
let backoff = 1000
let currentWorld = null
let loopTimer = null
let chatUnsub = null

function teardown() {
  if (loopTimer) {
    clearTimeout(loopTimer)
    loopTimer = null
  }
  if (chatUnsub) {
    chatUnsub()
    chatUnsub = null
  }
}

function runLoop(world) {
  const tick = () => {
    if (stopped) return
    act(world, decide(perceive(world)))
    loopTimer = setTimeout(tick, TICK_MS)
  }
  tick()
}

function connect() {
  if (stopped) return
  const world = createNodeClientWorld()
  currentWorld = world

  // A start that fails (the node client could not be set up, the address is not one) is said and tried again like
  // a lost connection: it used to be a rejection nobody handled, and the agent stayed up doing nothing.
  Promise.resolve()
    .then(() =>
      world.init({
        wsUrl: WS_URL,
        name: AGENT_NAME,
        avatar: AGENT_AVATAR,
        authToken: latestToken || loadToken(),
        onAuthToken: token => saveToken(token),
      })
    )
    .catch(err => {
      console.error(`[agent ${AGENT_ID}] start failed: ${logText(err?.message || err)}`)
      retry(world)
    })

  world.once('ready', () => {
    console.log(`[agent ${AGENT_ID}] ready`)
    backoff = 1000 // reset on successful connect
    // perceive: 他プレイヤーの発言をログ
    chatUnsub = world.chat.subscribe(msgs => {
      const last = msgs[msgs.length - 1]
      const myId = world.entities.player?.data.id
      if (last && last.fromId && last.fromId !== myId) {
        // (another player's text, on the operator's terminal: without its control characters)
        console.log(`[chat] ${logText(last.from, 80)}: ${logText(last.body)}`)
      }
    })
    runLoop(world)
  })

  world.on('kick', code => {
    console.log(`[agent ${AGENT_ID}] kicked: ${code}`)
    if (code === 'moderation' || code === 'kicked' || code === 'duplicate_user' || code === 'outdated') {
      console.error(`[agent ${AGENT_ID}] not retrying (${code})`)
      if (code === 'outdated') {
        console.error(`[agent ${AGENT_ID}] rebuild the node client (npm run node-client:build) and restart`)
      }
      stopped = true
    }
    // transient kicks (player_limit 等) は disconnect ハンドラ経由で再接続
  })

  world.on('disconnect', () => retry(world))
}

// this world is over (its connection closed, or it never started): the next one is made after the backoff. Once
// for a world: a start that failed and a disconnect of the same world do not both start a new one
function retry(world) {
  if (currentWorld !== world) return
  teardown()
  try {
    world.destroy()
  } catch (err) {
    console.error(`[agent ${AGENT_ID}] destroy failed: ${logText(err?.message || err)}`)
  }
  currentWorld = null
  if (stopped) return
  console.log(`[agent ${AGENT_ID}] disconnected — reconnecting in ${backoff}ms`)
  setTimeout(connect, backoff)
  backoff = Math.min(backoff * 2, MAX_BACKOFF)
}

// --- graceful shutdown ---
function shutdown() {
  console.log(`[agent ${AGENT_ID}] shutting down`)
  stopped = true
  teardown()
  try {
    currentWorld?.destroy()
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

connect()
