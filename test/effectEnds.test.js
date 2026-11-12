// The moment an effect is over, on the real player classes: the callback of the effect that ended runs after the
// new state is in place, so an effect it gives stays. (It used to run first and was then wiped together with what
// it had set: a handle went on believing in an effect the player no longer had.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './lib/clientHarness.mjs'

const Remote = loadClient('core/entities/PlayerRemote.js', 'PlayerRemote')
const Local = loadClient('core/entities/PlayerLocal.js', 'PlayerLocal')

function remote() {
  return Object.assign(Object.create(Remote.prototype), { data: { id: 'p', effect: null }, body: { active: true } })
}
function local() {
  const sent = []
  const player = Object.assign(Object.create(Local.prototype), {
    data: { id: 'p', effect: null },
    world: { network: { send: (name, data) => sent.push([name, data]) }, emit() {} },
  })
  return { player, sent }
}
const efs = sent => sent.filter(([name, data]) => name === 'entityModified' && 'ef' in data).map(([, data]) => data.ef)

test('PlayerRemote.setEffect: the callback of the effect that ended runs once, with the new effect in place', () => {
  const player = remote()
  const seen = []
  player.setEffect({ freeze: true }, () => seen.push(['first ended', player.data.effect]))
  assert.deepEqual(seen, [])
  // replaced: the callback sees the effect that took the place
  player.setEffect({ snare: 0.5 }, () => seen.push(['second ended', player.data.effect]))
  assert.deepEqual(seen, [['first ended', { snare: 0.5 }]])
  // ended: it sees none
  player.setEffect(null)
  assert.deepEqual(seen.at(-1), ['second ended', null])
  assert.equal(player.onEffectEnd, undefined)
  // no effect, nothing to call
  player.setEffect(null)
  assert.equal(seen.length, 2)
  // a callback handed over with no effect is not an effect's: it is not called when one is set later
  player.setEffect(null, () => seen.push('called for nothing'))
  player.setEffect({ freeze: true })
  assert.equal(seen.length, 2)
})

test('PlayerRemote.setEffect: an effect the callback gives stays, with its own callback', () => {
  const player = remote()
  const seen = []
  const successor = { anchorId: 'seat' }
  player.setEffect({ freeze: true }, () => {
    seen.push('first ended')
    player.setEffect(successor, () => seen.push('successor ended'))
  })
  // the player's client says the effect is over (PlayerRemote.modify -> setEffect(null))
  player.modify({ ef: null })
  assert.deepEqual(seen, ['first ended'])
  assert.equal(player.data.effect, successor, 'what the callback set is the effect now')
  assert.equal(player.body.active, false, 'and the body follows it (an anchored player is not simulated)')
  // and it ends as any other, telling its own callback
  player.setEffect(null)
  assert.deepEqual(seen, ['first ended', 'successor ended'])
  assert.equal(player.data.effect, null)
  assert.equal(player.body.active, true)
})

test('PlayerLocal.setEffect: the end is sent before the callback runs, and what the callback gives goes out after it', () => {
  const { player, sent } = local()
  const seen = []
  player.setEffect({ freeze: true }, () => {
    seen.push('ended')
    player.setEffect({ snare: 0.5 }, () => seen.push('successor ended'))
  })
  player.setEffect(null)
  assert.deepEqual(seen, ['ended'])
  assert.deepEqual(efs(sent), [{ freeze: true }, null, { snare: 0.5 }])
  assert.deepEqual(player.data.effect, { snare: 0.5 })
  player.setEffect(null)
  assert.deepEqual(seen, ['ended', 'successor ended'])
  assert.deepEqual(efs(sent).at(-1), null)
})

test('PlayerLocal.modify: an effect the server ends: the callback runs after, and an effect it gives is kept and sent', () => {
  const { player, sent } = local()
  const seen = []
  // a client script's effect on its own player, whose end gives another
  player.setEffect({ freeze: true }, () => {
    seen.push('ended')
    player.setEffect({ snare: 0.5 }, () => seen.push('successor ended'))
  })
  sent.length = 0
  // the server says the effect is over (a server script took it back)
  player.modify({ ef: null })
  assert.deepEqual(seen, ['ended'])
  assert.deepEqual(player.data.effect, { snare: 0.5 }, 'not overwritten by the value that ended the first')
  assert.deepEqual(efs(sent), [{ snare: 0.5 }], 'and the server is told of it')
  // the successor still has its callback
  player.modify({ ef: null })
  assert.deepEqual(seen, ['ended', 'successor ended'])
  assert.equal(player.data.effect, null)
})

test('PlayerLocal.modify: an effect the server gives takes the place of the current one, whose callback is told', () => {
  const { player, sent } = local()
  const seen = []
  player.setEffect({ freeze: true }, () => seen.push(['ended', player.data.effect]))
  sent.length = 0
  const fromServer = { snare: 0.25 }
  player.modify({ ef: fromServer })
  assert.deepEqual(seen, [['ended', fromServer]])
  assert.equal(player.data.effect, fromServer)
  assert.equal(player.onEffectEnd, null, "the server's effect has no callback here")
  assert.deepEqual(efs(sent), [], 'nothing is sent back for a change the server made')
})
