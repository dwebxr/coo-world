// What agent.mjs does with the machine it runs on: where its token is kept, how it is written, and what of other
// players' text reaches the operator's terminal. Apart from the file itself so that it can be tested without the
// node client's build.
import fs from 'node:fs'
import path from 'node:path'

// AGENT_ID names the agent's token file, so it is part of a file name and nothing else: letters, digits, `_`, `-`
// and `.`, with no separator. (It went into the path as it was: `../../../x` wrote the token outside the
// directory.) -> the id, or null
export function agentId(value) {
  const id = value === undefined || value === '' ? 'default' : value
  return typeof id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(id) ? id : null
}

export const tokenFileOf = (dir, id) => path.join(dir, `.agent-token-${id}.json`)

// The token is the agent's identity in the world (its rank goes with it): the file is the owner's alone to read.
// It is written to a new file of its own, made with that mode and only if no such file exists, and then renamed
// over the token file: the token is never in a file others can read, also when the token file was there before
// with another mode (one written before this was 0644) or is a link to somewhere else (the rename replaces the
// link, it does not follow it). On a system without such modes (Windows) the mode is ignored.
export function saveTokenFile(file, token, { fs: io = fs, suffix = `${process.pid}-${Date.now()}` } = {}) {
  const fresh = `${file}.${suffix}.tmp`
  io.writeFileSync(fresh, JSON.stringify({ authToken: token }), { mode: 0o600, flag: 'wx' })
  try {
    io.renameSync(fresh, file)
  } catch (err) {
    io.rmSync(fresh, { force: true })
    throw err
  }
}

// Text another player chose (a name, a chat line), for a log line: control characters, among them the escape
// sequences a terminal obeys, and the characters that reorder text are replaced, and the line is cut.
export function logText(value, max = 500) {
  let text
  try {
    text = String(value)
  } catch {
    return '?'
  }
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?')
  return text.length > max ? `${text.slice(0, max)}…` : text
}
