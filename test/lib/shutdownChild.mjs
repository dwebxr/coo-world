// A process with the server's real signal handling (src/server/shutdown.js). argv[2] says what the final save does:
// `stall` never settles, `reject` fails, `ok` resolves; `early` never attaches a world (a signal during start-up);
// `slowdb` runs the real ServerNetwork final save against a database whose every write blocks the thread for 50 ms
// (as better-sqlite3 does on a slow disk), with 40 dirty blueprints; `slowconfig` the same with 200 queued config
// writes. Prints `ready` once the handlers are in. argv[4]: the network the test built ({ url, env } of loadNetwork).
import { installShutdown } from '../../src/server/shutdown.js'

const mode = process.argv[2]
const say = line => process.stdout.write(`${line}\n`)
const deadlineMs = Number(process.argv[3] || 3500)

// the real network (test/lib/network.mjs) the test built, on `db`. No test ends here: the final save the signal
// starts stops it (flushBeforeExit stops it for good first)
async function realNetwork(db) {
  const { importNetwork, makeNetwork } = await import('./network.mjs')
  const net = await importNetwork(JSON.parse(process.argv[4]))
  return makeNetwork({ after() {} }, { net, world: { settings: { serialize: () => ({}) } }, init: { db } })
}

let network
if (mode === 'slowconfig') {
  // 200 config writes queued (saveConfig), each blocking the thread for 50 ms
  network = await realNetwork(() => ({
    insert: () => ({
      onConflict: () => ({
        merge: async () => {
          const end = Date.now() + 50
          while (Date.now() < end) {
            // a synchronous write
          }
          say('config written')
        },
      }),
    }),
  }))
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  network.loadedConfig.set('spawn', JSON.stringify(network.spawn))
  for (let i = 1; i <= 200; i++) network.saveConfig('spawn', { position: [i, 0, 0], quaternion: [0, 0, 0, 1] })
  network.spawn = { position: [200, 0, 0], quaternion: [0, 0, 0, 1] }
} else if (mode === 'slowdb') {
  const block = ms => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // a synchronous write
    }
  }
  network = await realNetwork(() => ({
    insert: row => ({
      onConflict: () => ({
        merge: async () => {
          block(50)
          say(`saved ${row.id}`)
        },
      }),
    }),
  }))
  for (let i = 0; i < 40; i++) network.markBlueprintDirty({ id: `bp${i}`, version: 0 })
} else if (mode !== 'early') {
  network = {
    flushBeforeExit(ms) {
      say(`flush started deadline=${ms}`)
      if (mode === 'stall') return new Promise(() => {})
      if (mode === 'reject') return Promise.reject(new Error('final save incomplete'))
      return Promise.resolve()
    },
  }
}
const shutdown = installShutdown({ deadlineMs })
if (network) {
  shutdown.attach({
    network,
    stopWorld: () => say('world stopped'),
    closeServer: () => say('server closing'),
  })
}
// keeps the process alive the way the listening server does
setInterval(() => {}, 1000)
say('ready')
