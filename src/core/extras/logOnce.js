// Log a message once per subject and key, then stay quiet. A client that keeps sending a packet the server
// drops, or an app whose events keep being refused, would otherwise write a line per occurrence. The subjects
// are held weakly, so a gone socket or app takes its keys with it.
export function createLogOnce(log = console.warn) {
  const seen = new WeakMap()
  return (subject, key, message) => {
    let keys = seen.get(subject)
    if (!keys) seen.set(subject, (keys = new Set()))
    if (keys.has(key)) return false
    keys.add(key)
    log(message)
    return true
  }
}
