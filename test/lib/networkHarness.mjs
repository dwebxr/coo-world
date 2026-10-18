import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import moment from 'moment'
import { appPersistenceData, persistenceRecord } from '../../src/core/extras/persistenceRecord.js'
import { uuid } from '../../src/core/utils.js'
import { PROTOCOL_VERSION, packetNameById, peekPacketId, writePacket } from '../../src/core/packets.js'
import { createWriteLedger, SNAPSHOT_CAP } from '../../src/core/extras/writeLedger.js'
import { createInboundGate, createInboundScheduler, packetNodeLimit } from '../../src/core/extras/inboundPolicy.js'
import { createEventLedger } from '../../src/core/extras/appEventQueue.js'
import { briefError, createLogOnce } from '../../src/core/extras/logOnce.js'
import {
  sanitizeBlueprintAdd,
  sanitizeBlueprintModify,
  WORLD_BLUEPRINT_BYTES,
} from '../../src/core/extras/blueprintPolicy.js'
import {
  sanitizeAppModify,
  sanitizeAppRelease,
  sanitizeEntityAdd,
  sanitizePlayerSelfModify,
  sanitizeName,
  sanitizePersistedApp,
  sanitizeSpawn,
} from '../../src/core/extras/entityModifyPolicy.js'
import { readInboundPacket } from '../../src/server/inboundDecode.js'
import * as solanaGating from '../../src/server/solana-gating.js'
import { grantTokenRank, persistRank, revokeTokenRank } from '../../src/server/rankGrants.js'
import { createSolanaRpc } from '../../src/server/solanaRpc.js'
import { createTokenBalanceService } from '../../src/server/tokenBalance.js'
import { Ranks } from '../../src/core/extras/ranks.js'
import { clientIpKeys } from '../../src/server/uploadLimits.js'

export const serverSource = fs.readFileSync(new URL('../../src/server/index.js', import.meta.url), 'utf8')
const source = fs.readFileSync(new URL('../../src/core/systems/ServerNetwork.js', import.meta.url), 'utf8')
const names = [
  'init',
  'start',
  'onDisconnect',
  'onCommand',
  'onModifyRank',
  'invalidateWallet',
  'current',
  'checkBuilderBalance',
  'onRequestBuilderNonce',
  'onRequestBuilderByToken',
  'onRequestBuilderRecheck',
  'onTokenBalanceRequest',
  'onRevokeBuilderByToken',
  'markBlueprintDirty',
  'markAppDirty',
  'markAppDeleted',
  'saveConfig',
  'preFixedUpdate',
  'asScript',
  'write',
  'send',
  'sendTo',
  'checkSockets',
  'admit',
  'enqueue',
  'flush',
  'requireBuilder',
  'onBlueprintAdded',
  'onBlueprintModified',
  'revertBlueprint',
  'onEntityAdded',
  'onEntityModified',
  'onSpawnModified',
]
const methods = names
  .map(name => {
    const method = source.match(new RegExp(`^  (?:async )?${name}(?:\\(| = )[^]*?^  }`, 'm'))?.[0]
    assert.ok(method, `${name} method found`)
    return method
  })
  .join('\n')
function networkClass(context) {
  return vm.runInNewContext(`(class Network { ${methods} })`, {
    writePacket,
    packetNameById,
    peekPacketId,
    Uint8Array,
    Date,
    JSON,
    moment,
    appPersistenceData,
    persistenceRecord,
    uuid,
    packetNodeLimit,
    readInboundPacket,
    briefError,
    sanitizeBlueprintAdd,
    sanitizeBlueprintModify,
    WORLD_BLUEPRINT_BYTES,
    defaultSpawn: '{"position":[0,0,0],"quaternion":[0,0,0,1]}',
    SAVE_INTERVAL: 0,
    process: { env: {} },
    console,
    solanaGating,
    grantTokenRank,
    persistRank,
    revokeTokenRank,
    createSolanaRpc,
    createTokenBalanceService,
    Ranks,
    sanitizeAppModify,
    sanitizeAppRelease,
    sanitizeEntityAdd,
    sanitizePlayerSelfModify,
    sanitizeName,
    sanitizePersistedApp,
    sanitizeSpawn,
    isObject: value => value !== null && typeof value === 'object',
    ...context,
  })
}
const socketSource = fs.readFileSync(new URL('../../src/core/Socket.js', import.meta.url), 'utf8')
export const Socket = vm.runInNewContext(`(${socketSource.slice(socketSource.indexOf('class Socket'))})`, {
  writePacket,
})

export function makeNetwork(log = () => {}, { context, tokenBalanceService } = {}) {
  const Network = networkClass(context)
  const network = new Network()
  network.init({ tokenBalanceService })
  network.isServer = true
  network.id = 0
  network.sockets = new Map()
  network.connecting = new Set()
  network.dirtyBlueprints = new Map()
  network.dirtyApps = new Map()
  network.loadedConfig = new Map()
  network.dirtyConfig = new Map()
  network.persistenceRevision = 0
  network.logOnce = createLogOnce(log)
  network.writer = createWriteLedger({ log })
  network.gate = createInboundGate({ log })
  network.scheduler = createInboundScheduler()
  network.world = {
    apps: { eventLedger: createEventLedger() },
    livekit: { clearModifiers() {} },
  }
  return network
}

export function fakeWs() {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.pending = []
  ws.packets = []
  ws.terminations = 0
  ws.send = (packet, cb) => {
    ws.packets.push(packet)
    ws.pending.push(cb)
  }
  ws.ping = (data, mask, cb) => {
    assert.equal(data, undefined)
    assert.equal(mask, false)
    ws.pending.push(cb)
  }
  ws.terminate = () => {
    ws.terminations++
    if (ws.readyState === 3) return
    ws.readyState = 3
    ws.emit('close')
  }
  ws.close = ws.terminate
  ws.drain = () => {
    for (const cb of ws.pending.splice(0)) cb()
  }
  return ws
}

// Run the actual index.js options, preValidation and route without booting physics or a database.
export function loadRoute(limits, network, config = { clientIpHeader: '' }) {
  const admission = serverSource.match(/^function admitConnection\([^]*?^}/m)?.[0]
  const route = serverSource.match(/^async function worldNetwork\([^]*?^}/m)?.[0]
  const options = serverSource.match(/fastify.register\(ws, (\{\n {2}options: \{[^]*?\n\})\)/)?.[1]
  assert.ok(admission && route && options)
  const context = vm.createContext({
    PROTOCOL_VERSION,
    writePacket,
    clientIpKeys,
    connectionLimits: limits,
    uploadLimitsConfig: config,
    kLease: Symbol('lease'),
    world: { network },
  })
  vm.runInContext(`${admission}\n${route}`, context)
  return {
    register: vm.runInContext('worldNetwork', context),
    preValidation: vm.runInContext('admitConnection', context),
    options: vm.runInContext(`(${options})`, context),
  }
}

export function connectionMethod(context) {
  const method = source.match(/^ {2}async onConnection\([^]*?^ {2}}/m)?.[0]
  assert.ok(method)
  return vm.runInNewContext(`(class { ${method} }).prototype.onConnection`, {
    writePacket,
    SNAPSHOT_CAP,
    Socket,
    briefError,
    solanaGating,
    ...context,
  })
}
