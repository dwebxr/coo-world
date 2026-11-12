// What agent.mjs does with the machine it runs on: where its token is kept, how it is written, and what of other
// players' text reaches the operator's terminal. Apart from the file itself so that it can be tested without the
// node client's build.
import fs from 'node:fs'
import path from 'node:path'

// AGENT_ID names the agent's token file, so it is a file name and nothing else: letters, digits, `_` and `-`.
// (It went into the path as it was: `../../x` wrote the token outside the directory.) -> the id, or null
export function agentId(value) {
  const id = value === undefined || value === '' ? 'default' : value
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null
}

export const tokenFileOf = (dir, id) => path.join(dir, `.agent-token-${id}.json`)

// The token is the agent's identity in the world (its rank goes with it): the file is the owner's alone to read.
// The mode is given at creation and set again for a file that was already there with another one (a token file
// written before this was 0644). On a system without such modes (Windows) chmod does what it can.
export function saveTokenFile(file, token, { writeFileSync = fs.writeFileSync, chmodSync = fs.chmodSync } = {}) {
  writeFileSync(file, JSON.stringify({ authToken: token }), { mode: 0o600 })
  chmodSync(file, 0o600)
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
