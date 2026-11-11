// Node graph limits (enforced in nodes/Node.js).
//
// Per-app node budget, counted on mount/unmount (so built-but-unmounted nodes, eg discarded clones, cost nothing):
// at most NODE_LIMIT live nodes and NODE_DEPTH_LIMIT levels below a mounted root. Past either, the node is not
// mounted and the app crashes like any other script failure. Every tree walk recurses, so the depth cap is also
// what keeps activate/deactivate (and walks of mounted trees) far from the stack limit.
export const NODE_LIMIT = 20000
export const NODE_DEPTH_LIMIT = 256
// a bound for loops that climb parent links, which Node.add keeps acyclic; reaching it means a corrupted graph
export const NODE_CLIMB_LIMIT = 65536

// thrown out of Node.activate() (and so out of the add/world.add/active write that mounted the node)
export class NodeLimitError extends Error {}

// World-space nodes: an app lists the nodes it placed in world space (worldNodes) and tears them down with it. A
// node is listed by one app at a time: placing it again (for another app) or moving it under a node takes it off
// the previous app's list, so that app's teardown or world.remove never touches it.
export function placeWorldNode(entity, node) {
  const previous = node._worldOwner
  if (previous && previous !== entity) previous.worldNodes?.delete(node)
  node._worldOwner = entity
  entity.worldNodes.add(node)
}

export function unplaceWorldNode(node) {
  const owner = node._worldOwner
  if (!owner) return
  owner.worldNodes?.delete(node)
  node._worldOwner = null
}

// App roots: the node an app's `app` proxy stands for (App.build marks it `_appRoot`) is placed and torn down by its
// app. It cannot be moved into another app's tree or world-space list (its app's teardown would unmount it there);
// an app moving its own root keeps working as before.
export function assertMovableRoot(node, entity, where) {
  if (node?._appRoot && node._appRoot !== entity) throw new Error(`[${where}] cannot add another app's root node`)
}

// the app a tree belongs to: the app whose root, or whose world-space node, is at its top (null for a tree that is
// not placed anywhere)
export function treeApp(node) {
  let top = node
  let steps = 0
  while (top.parent) {
    if (++steps > NODE_CLIMB_LIMIT) return null
    top = top.parent
  }
  return top._appRoot || top._worldOwner || null
}
