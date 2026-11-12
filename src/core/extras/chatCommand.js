// How a chat line that starts with "/" is read, on the client (Chat.command) and, for the admin command, on the
// server (ServerNetwork.onCommand) and at start-up (adminCode.js, whether ADMIN_CODE can be typed).
import { CHAT_BODY_MAX_LENGTH, cutText } from './chatPolicy.js'

// the words of a command: split at each space character, each one trimmed, empty ones dropped
export const commandWords = text =>
  text
    .split(' ')
    .map(word => word.trim())
    .filter(word => !!word)

// A command line as Chat.command reads it: cut to a chat message's length, then the leading character dropped.
// `cmd` is what comes before the first space and `value` what follows it, both untrimmed; `args` are its words.
// The server reads `args` only.
export function parseCommand(text) {
  const line = cutText(text, CHAT_BODY_MAX_LENGTH).slice(1)
  const cmd = line.split(' ')[0]
  return { cmd, value: line.slice(cmd.length + 1), args: commandWords(line) }
}

// A command packet as the server takes it from a client -> { cmd, value, args }, the shape Chat.command gives a
// client script's `command` event, or null when the packet is not a command line: `args` must be a list of strings
// that a chat line can hold (their words and the spaces between them within a chat message's length). A client is
// free to send anything else in that list (numbers, objects), and server scripts used to be handed it.
// `cmd` and `value` are the client's when they are text those words come from (commandWords of it gives exactly
// `args`), and are made from `args` otherwise. The entries of `args` themselves are taken as they are: a client of
// someone's own making can send one with a space in it or an empty one, which commandWords would never give.
export function readCommandPacket(data) {
  const args = data?.args
  if (!Array.isArray(args) || !args.every(word => typeof word === 'string')) return null
  if (args.reduce((length, word) => length + word.length + 1, 0) > CHAT_BODY_MAX_LENGTH) return null
  const { cmd, value } = data
  if (typeof cmd === 'string' && typeof value === 'string' && cmd.length + value.length < CHAT_BODY_MAX_LENGTH) {
    const words = commandWords(`${cmd} ${value}`)
    if (words.length === args.length && words.every((word, i) => word === args[i])) return { cmd, value, args }
  }
  return { cmd: args[0] ?? '', value: args.slice(1).join(' '), args }
}

const ADMIN_COMMAND = 'admin'

// the longest code `/admin <code>` can carry in one chat line
export const ADMIN_CODE_TYPED_MAX_LENGTH = CHAT_BODY_MAX_LENGTH - `/${ADMIN_COMMAND} `.length

// Whether a command's words are the admin command: a first word that is `admin` in any letter case. The client
// (which then hands the line to nothing but the server, since the code is in it) and the server (which then takes
// the second word for a code) both decide it here, from the same words, so no spelling is the admin command on one
// side only.
export function isAdminCommand(args) {
  if (!Array.isArray(args)) return false
  const first = args[0]
  return typeof first === 'string' && first.trim().toLowerCase() === ADMIN_COMMAND
}
