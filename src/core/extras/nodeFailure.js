// A per-frame system that works through script-owned nodes (action prompts, pointer paths, LOD switches,
// particles, avatars) must not let one node stop the frame for every visitor: the node's handling is skipped,
// reported once, and the app that owns it crashes through its usual crash path (its rebuild replaces the node).
import { briefError, createLogOnce } from './logOnce.js'

const logNodeFailure = createLogOnce(message => console.error(message))

export function nodeFailed(node, system, err) {
  const owner = node?.ctx?.entity ?? node?.hotOwner?.ctx?.entity
  const id = owner?.data?.id
  const label = typeof id === 'string' || typeof id === 'number' ? String(id).slice(0, 64) : 'none'
  logNodeFailure(node ?? logNodeFailure, system, `[${system}] a node failed (entity ${label}): ${briefError(err)}`)
  if (owner?.isApp && !owner.crashed) {
    owner.scriptError = { name: 'Error', message: `[${system}] a node of this app failed` }
    owner.crash?.()
  }
  return owner
}
