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
