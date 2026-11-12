// What a player's own client changed on its player during one server tick, merged per player.
//
// A client sends its player's movement as it changes (a few packets a second), and a script may teleport the player
// or set an effect on every frame; a hostile client sends as many as the inbound gate admits, about a thousand a
// second. Each such packet used to be written to every other connection as it was handled. The server still applies
// each one as it is handled; what it tells the others is kept here until the end of the tick's flush
// (ServerNetwork.flushPending), one packet per player with the latest value of every field named in that tick. The
// values in between are not sent.
//
// Player changes only: an entry is keyed by the player's id, which is also its connection's. Nothing here is kept
// from one tick to the next: the network takes every entry at the end of each flush.
export function createPendingChanges() {
  // player id -> { id, ...fields }, in the order the players first changed in this tick
  const entries = new Map()
  return {
    get size() {
      return entries.size
    },
    // `fields`: { id, ... } as the handler applied them
    merge(fields) {
      const entry = entries.get(fields.id)
      if (!entry) {
        entries.set(fields.id, { ...fields })
        return
      }
      // every field takes its latest value. `t` marks the position as a teleport (a receiver goes there at once
      // instead of gliding): it is only ever true, so once a change of the tick carried it the merged one does,
      // along with the latest position
      Object.assign(entry, fields)
    },
    // The server itself told everyone `fields` about this player (a script's effect, a rank, a name): those are
    // later than what the player's client sent before in this tick, so they are taken out of what is pending for
    // it. An entry with nothing left to say goes (`t` alone says nothing: it comes with a position).
    supersede(id, fields) {
      const entry = entries.get(id)
      if (!entry) return
      for (const key of Object.keys(fields)) {
        if (key !== 'id') delete entry[key]
      }
      if (Object.keys(entry).every(key => key === 'id' || key === 't')) entries.delete(id)
    },
    // the player is gone: nothing more is said about it
    drop(id) {
      entries.delete(id)
    },
    // every entry, in the order the players first changed; nothing is left
    takeAll() {
      const all = [...entries.values()]
      entries.clear()
      return all
    },
  }
}
