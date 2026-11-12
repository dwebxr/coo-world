import { System } from './System'

/**
 * Anchor System
 *
 * - Runs on both the server and client.
 * - Keeps track of anchors for easy access by player entities
 *
 */
export class Anchors extends System {
  constructor(world) {
    super(world)
    this.matrices = new Map() // id -> [...matrix]
  }

  // An id is `<entity id>:<node id>`, and two mounted anchors can have the same one: a clone keeps its source's node
  // id, and nothing stops a script from giving two anchors one id. Each id keeps every matrix mounted under it, in
  // mount order, and answers with the last, as before. It used to keep one: the first of the two to unmount deleted
  // the id, and the anchor still mounted had none (a player seated on it was let go).
  get(id) {
    return this.matrices.get(id)?.at(-1)
  }

  add(id, matrix) {
    const mounted = this.matrices.get(id)
    if (!mounted) {
      this.matrices.set(id, [matrix])
    } else if (!mounted.includes(matrix)) {
      mounted.push(matrix)
    }
  }

  remove(id, matrix) {
    const mounted = this.matrices.get(id)
    if (!mounted) return
    const idx = mounted.indexOf(matrix)
    if (idx === -1) return
    mounted.splice(idx, 1)
    if (!mounted.length) this.matrices.delete(id)
  }

  destroy() {
    this.matrices.clear()
  }
}
