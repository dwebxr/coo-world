// Who may do what in the world: the builder check of the builder handlers (requireBuilder), the avatar of a player
// without one of their own (defaultAvatar) and what a player who stops being a builder keeps (dropBuilderUrls), the
// chat commands (onCommand: `/admin <code>` against the admin code and its brake, `/name`, `/spawn`, `/chat clear`,
// `/server stats`, the others handed to server scripts), a change of rank by an admin (onModifyRank), and kick and
// mute with the rule they share (moderated, onKick, onMute). Moved here as written from
// src/core/systems/ServerNetwork.js (P16): it is a part of that class's file, not a module of its own design. Each
// function's `this` is the network (ServerNetwork declares every one as a member of the kind it had and calls it with
// itself), and they call one another through it, and the class's own members as well (spend, send, storeRank,
// userRows, onSpawnModified, and admin and kicks, which stay in the class with the modules they are made from). The
// state is where it was: on the network (the admin mode and its brake, the kick list, the action budgets) and on the
// connections and their players.
import moment from 'moment'
import { uuid } from '../../core/utils'
import { Ranks } from '../../core/extras/ranks'
import { isExternalUrl, sanitizeName } from '../../core/extras/entityModifyPolicy'
import { isAdminCommand, readCommandPacket } from '../../core/extras/chatCommand'
import { previewValue } from '../../core/extras/assetURL'
import { eventPayload } from '../../core/extras/eventPayload.js'

// inbound packet payloads are untrusted; handlers check the root shape before any lookup
const isObject = value => value !== null && typeof value === 'object'

export function requireBuilder(socket, action) {
  if (socket.player.isBuilder()) return true
  this.logOnce(
    socket,
    `builder:${action}`,
    `player attempted to ${action} without builder permission: ${previewValue(socket.id, 64)}`
  )
  return false
}

// the avatar of a player without one of their own, or with one they may not show: the world's, else the built-in one
export function defaultAvatar() {
  return this.world.settings.avatar?.url || 'asset://avatar.vrm'
}

// What a player may show only as a builder goes when they stop being one, whichever way that happens (an admin
// lowers their rank, `/admin` again, their token grant ends, the world's rank setting is lowered): a session
// avatar or an emote outside this world (entityModifyPolicy.js isExternalUrl), unless a server script chose it for
// this player, and a stored avatar outside this world, which shows as the world's default from here on, as it
// does at a join (the database keeps it). Everyone, the player included, is told in an entityModified packet, as
// of any other change to the player. A player who is still a builder keeps everything.
export function dropBuilderUrls(player) {
  if (!player?.isPlayer || player.destroyed || player.isBuilder()) return
  const assetsUrl = process.env.ASSETS_BASE_URL
  const { sessionAvatar, emote, avatar } = player.data
  const change = {}
  if (isExternalUrl(sessionAvatar, assetsUrl) && sessionAvatar !== player.scriptAvatar) change.sessionAvatar = null
  if (isExternalUrl(emote, assetsUrl) && player.scriptEmotes?.has(emote) !== true) change.e = null
  if (isExternalUrl(avatar, assetsUrl)) change.avatar = this.defaultAvatar()
  if (!Object.keys(change).length) return
  player.modify(change)
  this.send('entityModified', { id: player.data.id, ...change })
}

export async function onCommand(socket, data, meta) {
  // (a list of words as a chat line can hold them: chatCommand.js)
  const command = isObject(data) ? readCommandPacket(data) : null
  if (!command) return
  const { args } = command
  // handle slash commands
  const player = socket.player
  const playerId = player.data.id
  const [cmd, arg1] = args
  // The admin command (chatCommand.js, as the client decides it): it is never handed on as a command event (the
  // code is in it). A wrong code is answered and, past a few, slowed down (adminCode.js); this socket's line only,
  // never a broadcast.
  const adminCommand = isAdminCommand(args)
  // A command is a line a person types: two a second, with a few at once (actionBudget.js). The admin command is
  // not counted here: its attempts have a brake of their own (adminCode.js), which must see every one of them.
  if (!adminCommand && !this.spend(socket, 'command', meta, 'You are sending commands too fast.')) return
  if (adminCommand) {
    const attempt = this.admin().gate.attempt(
      { socket, user: player.data.userId, address: socket.addressKey, parents: socket.addressParents },
      arg1
    )
    if (!attempt.ok && attempt.tell) {
      socket.send('chatAdded', {
        id: uuid(),
        kind: 'system',
        from: null,
        fromId: null,
        body: attempt.reason === 'wrong' ? 'Wrong admin code.' : 'Too many attempts. Try again later.',
        createdAt: moment().toISOString(),
      })
    }
    if (attempt.reason === 'closed') {
      socket.send('kick', 'admin_attempts')
      socket.disconnect()
      return
    }
    // The right code clears its own brake, so a holder could turn admin on and off without end: each turn is a
    // rank written to everyone and to the database, and is counted with the other changes of rank.
    if (attempt.ok && !this.spend(socket, 'moderation', meta, 'You are changing ranks too fast.')) return
    if (attempt.ok) {
      const id = player.data.id
      const granted = !player.isAdmin()
      let rank
      if (granted) {
        rank = Ranks.ADMIN
      } else {
        rank = Ranks.VISITOR
      }
      player.rankRevision++
      player.modify({ rank })
      this.send('entityModified', { id, rank })
      this.dropBuilderUrls(player)
      socket.send('chatAdded', {
        id: uuid(),
        kind: 'system',
        from: null,
        fromId: null,
        body: granted ? 'Admin granted!' : 'Admin revoked!',
        createdAt: moment().toISOString(),
      })
      this.storeRank(player, rank)
    }
  }
  if (cmd === 'name') {
    const name = sanitizeName(arg1)
    // A name is written to everyone and to the database: one every two seconds, with a few at once. The name
    // the player has already is answered and changes nothing.
    const changed = !!name && name !== player.data.name
    if (changed && !this.spend(socket, 'identity', meta, 'You are changing your name too fast.')) return
    if (name) {
      const id = player.data.id
      const userId = player.data.userId
      if (changed) {
        player.data.name = name
        player.modify({ name })
        this.send('entityModified', { id, name })
      }
      socket.send('chatAdded', {
        id: uuid(),
        kind: 'system',
        from: null,
        fromId: null,
        body: `Name set to ${name}!`,
        createdAt: moment().toISOString(),
      })
      if (changed) this.userRows().intend(userId, { name })
    }
  }
  if (cmd === 'spawn') {
    const op = arg1
    this.onSpawnModified(socket, op, meta)
  }
  if (cmd === 'chat') {
    const op = arg1
    if (op === 'clear' && socket.player.isBuilder()) {
      this.world.chat.clear(true)
    }
  }
  if (cmd === 'server') {
    const op = arg1
    // process figures are for builders; a visitor's /server stats is ignored like any other unknown command
    if (op === 'stats' && socket.player.isBuilder()) {
      const send = body => {
        socket.send('chatAdded', {
          id: uuid(),
          kind: 'system',
          from: null,
          fromId: null,
          body,
          createdAt: moment().toISOString(),
        })
      }
      const stats = await this.world.monitor.getStats()
      send(`CPU: ${stats.currentCPU.toFixed(3)}%`)
      send(
        `Memory: ${stats.currentMemory} / ${stats.maxMemory} MB (${((stats.currentMemory / stats.maxMemory) * 100).toFixed(1)}%)`
      )
    }
  }
  // emit event for all except admin
  if (!adminCommand) {
    // the shape a client script gets from Chat.command (the server's event used to carry `args` alone)
    this.world.events.emit('command', eventPayload({ playerId, cmd: command.cmd, value: command.value, args }))
  }
}

export async function onModifyRank(socket, data, meta) {
  if (!socket.player.isAdmin()) return
  if (!isObject(data)) return
  const { playerId, rank } = data
  if (!playerId) return
  if (rank !== Ranks.VISITOR && rank !== Ranks.BUILDER && rank !== Ranks.ADMIN) return
  const player = this.world.entities.get(playerId)
  if (!player || !player.isPlayer) return
  // Where no admin code is set (`locked`), nobody becomes admin by typing one: an admin who lowers their own rank
  // has no way back but an edit of the database. That is refused, as a guard against a slip of the hand, and no
  // more than that: an admin can still lower every other admin, and two can lower each other.
  if (player === socket.player && rank < Ranks.ADMIN && this.admin().mode === 'locked') {
    socket.send('chatAdded', {
      id: uuid(),
      kind: 'system',
      from: null,
      fromId: null,
      body: 'This world has no admin code: you could not become admin again. Your rank was not changed.',
      createdAt: moment().toISOString(),
    })
    return
  }
  // a rank is written to everyone and to the database: counted with kicks and mutes, once it is one that is made
  if (!this.spend(socket, 'moderation', meta, 'You are changing ranks too fast.')) return
  player.rankRevision++
  player.modify({ rank })
  this.send('entityModified', { id: playerId, rank })
  this.dropBuilderUrls(player)
  this.storeRank(player, rank)
}

// The player a kick or a mute names, when the sender may: a player here (an app's id named none, and passed the
// rank comparison this replaces, since an app has no rank), outranked by the sender. Ranks are compared as the
// players pane compares them (playerRanks.outranks: the rank of the session, a token's grant included, and the
// world's): admins over builders and visitors, builders over visitors. Where everyone is an admin (a world open
// to all) nobody outranks anybody, so nobody kicks or mutes.
export function moderated(socket, playerId) {
  const player = this.world.entities.getPlayer(playerId)
  if (!player || !socket.player.outranks(player)) return null
  return player
}

// The kicked player is told, closed, and kept out for a while (kickList.js: that user id, and with
// KICK_BY_ADDRESS new users from its address when an admin kicks). Its client leaves the voice room on the kick
// and every other client drops its voice and screen with the player (ClientLiveKit).
export function onKick(socket, playerId, meta) {
  const player = this.moderated(socket, playerId)
  if (!player) return
  const tSocket = this.sockets.get(playerId)
  if (!tSocket) return
  // counted with mutes and ranks, once it is a kick that is made
  if (!this.spend(socket, 'moderation', meta)) return
  this.kicks().add({ userId: playerId, addressKey: tSocket.addressKey, byAdmin: socket.player.isAdmin() })
  console.log(
    `[network] ${previewValue(socket.id, 64)} kicked ${previewValue(playerId, 64)}` +
      (this.kicks().minutes ? `: kept out for ${this.kicks().minutes} min` : '')
  )
  tSocket.send('kick', 'moderation')
  tSocket.disconnect()
}

export function onMute(socket, data, meta) {
  if (!isObject(data) || typeof data.muted !== 'boolean') return
  const player = this.moderated(socket, data.playerId)
  if (!player) return
  // a mute is written to everyone; the players pane shows the state the server has, so a dropped one is seen
  if (!this.spend(socket, 'moderation', meta)) return
  this.world.livekit.setMuted(data.playerId, data.muted)
}
