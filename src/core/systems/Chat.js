import moment from 'moment'
import { uuid } from '../utils'
import { chatEnvelope, sanitizeChatMessage } from '../extras/chatPolicy'
import { isAdminCommand, parseCommand } from '../extras/chatCommand'
import { System } from './System'
import { eventPayload } from '../extras/eventPayload.js'

/**
 * Chat System
 *
 * - Runs on both the server and client.
 * - Stores and handles chat messages
 * - Provides subscribe hooks for client UI
 *
 */

const CHAT_MAX_MESSAGES = 50

export class Chat extends System {
  constructor(world) {
    super(world)
    this.msgs = []
    this.listeners = new Set()
    this.commands = {} // cmd -> Function
  }

  add(msg, broadcast) {
    msg = chatEnvelope(msg)
    if (!msg) return
    if (!msg.id) msg.id = uuid()
    if (!msg.createdAt) msg.createdAt = moment().toISOString()
    // add to chat messages
    this.msgs = [...this.msgs, msg]
    if (this.msgs.length > CHAT_MAX_MESSAGES) {
      this.msgs.shift()
    }
    for (const callback of this.listeners) {
      callback(this.msgs)
    }
    const body = msg.body
    // only a player's own message pops that player's bubble (an app or system line has no fromId)
    if (msg.kind === 'player' && msg.fromId) {
      const player = this.world.entities.getPlayer(msg.fromId)
      player?.chat(body)
    }
    // emit chat event
    const readOnly = Object.freeze({ ...msg })
    this.world.events.emit('chat', readOnly)
    // maybe broadcast
    if (broadcast) {
      this.world.network.send('chatAdded', msg)
    }
  }

  command(text) {
    if (this.world.network.isServer) return
    const playerId = this.world.network.id
    // "/foo bar" -> cmd "foo", value "bar", args ["foo", "bar"]
    const { cmd, value, args } = parseCommand(text)
    // The admin command (as the server decides it, from the same words) carries the code: it goes to the server and
    // nowhere else, not to a command bound here and not to scripts as a command event.
    if (isAdminCommand(args)) {
      this.world.network.send('command', { cmd, value, args })
      return
    }
    // (a command bound here, not a property every object has: `/constructor` is not one)
    const callback = Object.hasOwn(this.commands, cmd) ? this.commands[cmd] : undefined
    if (callback) {
      return callback({ playerId, cmd, value, args })
    }
    this.world.events.emit('command', eventPayload({ playerId, cmd, value, args }))
    this.world.network.send('command', { cmd, value, args })
  }

  clear(broadcast) {
    this.msgs = []
    for (const callback of this.listeners) {
      callback(this.msgs)
    }
    if (broadcast) {
      this.world.network.send('chatCleared')
    }
  }

  send(text) {
    // only available as a client
    if (!this.world.network.isClient) return
    // the check the server applies, so the local echo is the text everyone else receives
    const safe = sanitizeChatMessage({ body: text })
    if (!safe) return
    const player = this.world.entities.player
    const data = {
      id: uuid(),
      kind: 'player',
      from: player.data.name,
      fromId: player.data.id,
      body: safe.body,
      createdAt: moment().toISOString(),
    }
    this.add(data, true)
    return data
  }

  serialize() {
    return this.msgs
  }

  deserialize(msgs) {
    this.msgs = msgs
    for (const callback of this.listeners) {
      callback(msgs)
    }
  }

  subscribe(callback) {
    this.listeners.add(callback)
    callback(this.msgs)
    return () => {
      this.listeners.delete(callback)
    }
  }

  bindCommand(cmd, callback) {
    this.commands[cmd] = callback
  }

  destroy() {
    this.msgs = []
    this.listeners.clear()
  }
}
