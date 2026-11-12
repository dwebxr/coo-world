// How often one connection may do each kind of thing a person does by hand.
//
// The inbound gate (inboundPolicy.js) has one budget per connection for every packet: about a thousand small packets
// a second, whatever they are. That bounds the work of reading them, not what each one sets off: a chat line is
// written to every connection, a name change is written to every connection and to the database. A thousand chat
// lines a second from one visitor fill the write backlog of every recipient on a slow link, and a recipient whose
// backlog is full is disconnected (writeLedger.js).
//
// So the kinds of packet that a person sends at the speed of typing or clicking get a budget of their own, per
// connection: a token bucket (`rate` a second, up to `burst` at once), asked once the handler knows the action is
// one it would carry out. What goes over is not carried out when it arrives, and the handler (ServerNetwork) decides
// what becomes of it: a line of chat, a command, a spawn, a kick, a mute or a change of rank is dropped; a name,
// avatar or session avatar is taken out of its packet (whose other fields go on) and the sender is given back the
// value the server keeps; a world setting is held, the latest value of each, and applied when the budget allows.
//
// Script events (`event`) are the one kind here that nobody sends by hand: a client script sends them (app.send), at
// the rate its author chose, often one a frame. Their budget bounds how many events of one connection the server's
// apps take in a second: the app asks (App.onEvent) once it knows it would take the event, and one over the budget
// is dropped there, counted with the app's other dropped events. Nothing is held and nobody is closed.
//
// What this is not: a limit per person. A connection is cheap, and several of them multiply every number here; the
// limits on connections per address (connectionLimits.js) are what bounds that. Movement and building are not
// here: an honest client sends those at frame rate, and a dropped one leaves players out of step. (What a client
// changes on its own player is not refused but merged: the others are told once per server tick, pendingChanges.js.)

export const ACTION_BUDGETS = Object.freeze({
  // a line of chat typed by a player
  chat: Object.freeze({ rate: 1, burst: 6 }),
  // a line of chat sent by a client script on the player's behalf (a bucket of its own: a player who typed nothing
  // is not told they type too fast)
  appChat: Object.freeze({ rate: 2, burst: 10 }),
  // a change of the player's own name or avatar: written to everyone, and to the database
  identity: Object.freeze({ rate: 0.5, burst: 5 }),
  // a chat command
  command: Object.freeze({ rate: 2, burst: 10 }),
  // a world setting, and the spawn point. A number field sends a change per key repeat, about thirty a second while
  // an arrow key is held: those go out as they come for a second, and then the latest value of each setting goes
  // out five times a second (a setting is held, not dropped)
  settings: Object.freeze({ rate: 5, burst: 30 }),
  // a kick, a mute, a change of a player's rank (also the admin code's own toggle): each is written to everyone, a
  // rank to the database too. A bucket of its own, so that editing settings never leaves a moderator without one
  moderation: Object.freeze({ rate: 2, burst: 10 }),
  // a script event from a client that the app takes on the server: one it has a listener for, or keeps while it
  // builds. A script that sends one a frame sends 60 to 240 a second, depending on the display; two apps doing so
  // at 144 Hz send 288, which passes. This bounds small events: one of 6 KiB or more costs the inbound gate
  // (inboundPolicy.js) four units or more, and the gate lets fewer than 320 of those a second through
  event: Object.freeze({ rate: 320, burst: 1280 }),
})

// `budgets`: { [action]: { rate, burst } }. The state lives with the connection object and goes with it.
export function createActionBudgets(budgets = ACTION_BUDGETS) {
  const states = new WeakMap()
  const stateOf = (socket, action) => {
    let actions = states.get(socket)
    if (!actions) states.set(socket, (actions = new Map()))
    let state = actions.get(action)
    if (!state) actions.set(action, (state = { tokens: budgets[action].burst, at: null, refused: 0, telling: true }))
    return state
  }
  return {
    // One action of `socket` at time `at` (milliseconds on a clock that does not go back: when the packet arrived,
    // not when its turn came, so packets that waited in the inbox are not taken for a burst).
    // -> { ok: true } | { ok: false, tell }: `tell` is true for the first refusal since the last action that was
    // let through, so a sender is told once per wait and not once per packet. `notify`: whether the caller has
    // something to tell for this refusal. One it says nothing about (a setting that is held, a mute) leaves the
    // telling to the next refusal of this kind that has (a spawn, a change of rank).
    spend(socket, action, at, notify = true) {
      const budget = budgets[action]
      if (!budget) throw new Error(`no budget for ${action}`)
      const state = stateOf(socket, action)
      if (state.at !== null && at > state.at) {
        state.tokens = Math.min(budget.burst, state.tokens + ((at - state.at) / 1000) * budget.rate)
      }
      if (state.at === null || at > state.at) state.at = at
      if (state.tokens >= 1) {
        state.tokens -= 1
        state.telling = true
        return { ok: true }
      }
      state.refused++
      if (!notify) return { ok: false, tell: false }
      const tell = state.telling
      state.telling = false
      return { ok: false, tell }
    },
    // how many actions of this kind were refused to this connection
    refused(socket, action) {
      return states.get(socket)?.get(action)?.refused ?? 0
    },
  }
}
