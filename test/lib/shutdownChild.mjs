// A process with the server's real signal handling (src/server/shutdown.js) and a network whose final save does
// what argv[2] says: `stall` never settles, `reject` fails, `ok` resolves. Prints `ready` once the handlers are in.
import { installShutdown } from '../../src/server/shutdown.js'

const mode = process.argv[2]
const say = line => process.stdout.write(`${line}\n`)
const deadlineMs = Number(process.argv[3] || 3500)
const network = {
  flushBeforeExit(ms) {
    say(`flush started deadline=${ms}`)
    if (mode === 'stall') return new Promise(() => {})
    if (mode === 'reject') return Promise.reject(new Error('final save incomplete'))
    return Promise.resolve()
  },
}
installShutdown({
  network,
  deadlineMs,
  stopWorld: () => say('world stopped'),
  closeServer: () => say('server closing'),
})
// keeps the process alive the way the listening server does
setInterval(() => {}, 1000)
say('ready')
