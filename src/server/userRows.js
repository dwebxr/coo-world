// The rows of `users` as this server means them to be: what it has decided for a user (a name, an avatar, a rank)
// and may not have stored yet. Pure: the write, the clock of the final save and the question "is this user joining"
// are passed in, so the rules can be exercised without a database.
//
// One server process is the only writer of the table. So for a user whose row it has changed it knows the values
// it decided, whatever the database has got round to:
// - `intend` records a change at the moment it is decided (in the same turn in which the player in the world is
//   changed) and starts that user's writer when it is not running. It does not wait.
// - One writer per user, one statement at a time: it writes the columns whose decided value is not stored yet, as
//   they are when the statement starts, until none is left. So the database never takes an older decision of a
//   user after a newer one, on a pool of any size; a change decided while a statement is under way goes out with
//   the next one, and a value replaced before its turn came is never written.
// - A join puts `intended` over the row it read (ServerNetwork.onConnection): a row read before a write landed, or
//   before one that failed, does not bring the old value back.
// - A statement that fails: the writer stops. Nothing tries again by itself; the columns stay decided and unstored,
//   joins keep getting them from here, and they go out again with that user's next change or at the final save.
//   When the failed statement carried several columns, each is written once on its own first, so that one column
//   the database refuses (a value too long for it) does not hold back the others.
// - An entry is dropped once everything in it is stored and the user is not joining (`held`): a join that read the
//   row before a change may still be waiting, and takes the change from here.
// Nothing here tells anyone that a value has landed: what was decided holds for this process from the decision on.
//
// What this does not give:
// - Durability. A change the database has not taken is lost when the process ends without a final save (a crash,
//   a kill), and at the final save when the database still refuses it; `unstored` is what that save reports. The
//   next process has what the database held.
// - A repair of a write that can never succeed: it fails again each time it is tried.
// - Agreement with anything else that writes the table. A row edited by hand while the server runs is overwritten by
//   the next write of a column decided here, and a join takes the decided value over the edited one for as long as
//   the entry lives. Edit the table with the server stopped.
//
// Memory: one entry per user who has a change that is not stored, a write under way or a join under way. Measured
// (Node 24, 50,000 entries): about 400 bytes for an entry with one small value, about 1 KiB with the longest
// name, an avatar url of 255 characters and a rank (in one-byte characters; the two strings take twice their length
// in other scripts). There is no cap: there can be no more entries than the table has rows, and an entry outlasts
// its user's write and join only while the database has not taken something in it.

// update(userId, values) -> a promise: the statement that writes those columns of that user's row
// onFailure({ userId, columns, error }): a statement failed, said once per run of failures of a user (not again
//   until that user's writer has got through its columns without a failure)
// expired(): past the final save's deadline; no statement is started any more
// held(userId): the user has a join under way
export function createUserRows({ update, onFailure = () => {}, expired = () => false, held = () => false }) {
  // userId -> {
  //   values: column -> the value decided last,
  //   at: column -> the entry's version when that value was decided,
  //   stored: column -> the entry's version when the last statement for that column that landed was started,
  //   version: counts this user's changes,
  //   writing: the writer is running, failed: its last statement failed }
  const entries = new Map()

  const unstoredColumns = entry =>
    Object.keys(entry.values).filter(column => entry.at[column] > (entry.stored[column] ?? 0))

  const drop = userId => {
    const entry = entries.get(userId)
    // (while a statement is under way, a column it carries is unstored)
    if (!entry || unstoredColumns(entry).length || held(userId)) return
    entries.delete(userId)
  }

  // one statement, with those columns as they are now -> null when it landed, { error } when it failed
  const write = async (userId, entry, columns) => {
    const version = entry.version
    const values = {}
    for (const column of columns) values[column] = entry.values[column]
    try {
      await update(userId, values)
    } catch (error) {
      return { error }
    }
    for (const column of columns) entry.stored[column] = version
    return null
  }

  const run = async (userId, entry) => {
    entry.writing = true
    try {
      for (;;) {
        const columns = unstoredColumns(entry)
        if (!columns.length || expired()) break
        let failure = await write(userId, entry, columns)
        let refused = columns
        if (failure && columns.length > 1) {
          // one of them may be what the database refuses: each on its own, so the others are not held back
          refused = []
          failure = null
          for (const column of columns) {
            if (expired()) return
            const result = await write(userId, entry, [column])
            if (result) {
              refused.push(column)
              failure = result
            }
          }
        }
        if (failure) {
          if (!entry.failed) onFailure({ userId, columns: refused, error: failure.error })
          entry.failed = true
          break
        }
        entry.failed = false
      }
    } finally {
      entry.writing = false
      drop(userId)
    }
  }

  const start = (userId, entry) => {
    if (!entry.writing) entry.running = run(userId, entry)
    return entry.running
  }

  return {
    // Records a change of a user's row and starts its writer. Synchronous: the statement is started before this
    // returns when no other of that user is under way.
    intend(userId, changes) {
      let entry = entries.get(userId)
      if (!entry) {
        entry = { values: {}, at: {}, stored: {}, version: 0, writing: false, failed: false }
        entries.set(userId, entry)
      }
      entry.version++
      for (const column of Object.keys(changes)) {
        entry.values[column] = changes[column]
        entry.at[column] = entry.version
      }
      start(userId, entry)
    },

    // what a join puts over the row it read: the columns decided here, stored or not (null: nothing)
    intended(userId) {
      const entry = entries.get(userId)
      return entry ? { ...entry.values } : null
    },

    // called when a join of that user ends: the entry it kept alive may go
    sweep(userId) {
      drop(userId)
    },

    // settles when the writers that are running now have stopped
    async idle() {
      await Promise.all([...entries.values()].map(entry => entry.running))
    },

    // The final save: waits for the writers that are running, then gives the writer of each user one more run, one
    // user after the other, with a turn of the event loop before each (a synchronous database would otherwise go
    // through them all before a timer or a signal is seen). A run with nothing unstored starts no statement, and
    // no statement is started past the deadline (run, above); past it the remaining users are not gone through.
    async flush() {
      await this.idle()
      for (const [userId, entry] of [...entries]) {
        if (expired()) return
        await new Promise(resolve => setImmediate(resolve))
        await start(userId, entry)
      }
    },

    // how many users have a change the database has not taken
    unstored() {
      let count = 0
      for (const entry of entries.values()) if (unstoredColumns(entry).length) count++
      return count
    },

    get size() {
      return entries.size
    },
  }
}
