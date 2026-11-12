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
  isExternalUrl,
  sanitizeAppModify,
  sanitizeAppRelease,
  sanitizeEntityAdd,
  sanitizePlayerSelfModify,
  sanitizeName,
  sanitizePersistedApp,
  sanitizeSpawn,
  sessionAvatarRequest,
} from '../../src/core/extras/entityModifyPolicy.js'
import { readInboundPacket } from '../../src/server/inboundDecode.js'
import { appChatLine, sanitizeChatMessage } from '../../src/core/extras/chatPolicy.js'
import { eventPayload } from '../../src/core/extras/eventPayload.js'
import { internalEvents } from '../../src/core/extras/internalEvents.js'
import {
  isAdminOnlySettingKey,
  isKnownSettingKey,
  normalizeSettingValue,
} from '../../src/core/extras/settingsPolicy.js'
import * as solanaGating from '../../src/server/solana-gating.js'
import * as evmGating from '../../src/server/evm-gating.js'
import { parseTipAmount, tipAmountReason } from '../../src/core/extras/evmTokens.js'
import { createEvmRpcs } from '../../src/server/evmRpc.js'
import { createEvmHoldingService, readHoldingContractsEnv } from '../../src/server/evmHoldings.js'
import { createTipWatcher } from '../../src/server/evmTipWatcher.js'
import { formatUnits, isTxHash } from '../../src/core/extras/evmAbi.js'
import { grantTokenRank, rankStored, revokeTokenRank } from '../../src/server/rankGrants.js'
import { createUserRows } from '../../src/server/userRows.js'
import { adminMode, adminWaitScale, createAdminGate } from '../../src/server/adminCode.js'
import { createKickList, readKickEnv } from '../../src/server/kickList.js'
import { createActionBudgets } from '../../src/core/extras/actionBudget.js'
import { createPendingChanges } from '../../src/core/extras/pendingChanges.js'
import { isAdminCommand } from '../../src/core/extras/chatCommand.js'
import { createSolanaRpc } from '../../src/server/solanaRpc.js'
import { createTokenBalanceService } from '../../src/server/tokenBalance.js'
import { hasRank, Ranks } from '../../src/core/extras/ranks.js'
import { clientIpKeys } from '../../src/server/uploadLimits.js'
import { previewValue } from '../../src/core/extras/assetURL.js'
import {
  GROWTH_RESERVE_BYTES,
  OWN_AVATAR_MAX_LENGTH,
  RANKED_RESERVE_PLAYERS,
  SNAPSHOT_FIXED_BYTES,
  SNAPSHOT_STEP_NAMES,
  encodeSnapshot,
  envelopeBytes,
  fitsJoinState,
  joinStateBytes,
  joinStateReport,
  settingsBytes,
  visitorShortfall,
} from '../../src/core/extras/joinBudget.js'
import {
  PLAYER_NAME_MAX_LENGTH,
  SESSION_AVATAR_MAX_LENGTH,
  isBoundedJsonObject,
} from '../../src/core/extras/entityModifyPolicy.js'

export const serverSource = fs.readFileSync(new URL('../../src/server/index.js', import.meta.url), 'utf8')
const source = fs.readFileSync(new URL('../../src/core/systems/ServerNetwork.js', import.meta.url), 'utf8')
const names = [
  'init',
  'start',
  'hydrate',
  'saveDirty',
  'saveExpired',
  'onDisconnect',
  'releaseApps',
  'onChatAdded',
  'onAppChat',
  'userRows',
  'storeRank',
  'admin',
  'kicks',
  'moderated',
  'onKick',
  'onMute',
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
  'endTokenGrant',
  'invalidateEvmWallet',
  'currentEvm',
  'onRequestEvmNonce',
  'onRequestEvmVerify',
  'onRevokeEvmWallet',
  'onSetEvmTipReceive',
  'confirmsTips',
  'onRequestEvmTipIntent',
  'issueTipTicket',
  'onEvmTip',
  'pruneTipSeen',
  'onTipResult',
  'tipConfirmed',
  'announceTip',
  'drainTipAnnouncements',
  'dropTipTickets',
  'stopForFatal',
  'evmHolding',
  'markBlueprintDirty',
  'markAppDirty',
  'markAppDeleted',
  'rekeyApp',
  'replacementOf',
  'saveConfig',
  'joinRecord',
  'defaultAvatar',
  'dropBuilderUrls',
  'snapshotState',
  'measureFixedBytes',
  'preFixedUpdate',
  'asScript',
  'write',
  'broadcast',
  'send',
  'sendTo',
  'checkSockets',
  'answersPing',
  'playersPresent',
  'retireSocket',
  'admit',
  'spend',
  'settingAllowed',
  'releaseSettings',
  'heldAfter',
  'enqueue',
  'flush',
  'flushPending',
  'requireBuilder',
  'onBlueprintAdded',
  'onBlueprintModified',
  'revertBlueprint',
  'onEntityAdded',
  'onEntityModified',
  'onEntityRemoved',
  'onEntityEvent',
  'onSettingsModified',
  'onSpawnModified',
  'onAi',
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
    adminMode,
    adminWaitScale,
    createAdminGate,
    createKickList,
    readKickEnv,
    createActionBudgets,
    createPendingChanges,
    isAdminCommand,
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
    previewValue,
    SNAPSHOT_CAP,
    joinStateReport,
    settingsBytes,
    fitsJoinState,
    envelopeBytes,
    SNAPSHOT_FIXED_BYTES,
    OWN_AVATAR_MAX_LENGTH,
    PLAYER_NAME_MAX_LENGTH,
    SESSION_AVATAR_MAX_LENGTH,
    HEALTH_MAX: 100,
    performance,
    // the session token a join makes (the real one is a signed JWT; tests that need its size give their own)
    createJWT: async ({ userId }) => `jwt.${userId}`,
    isBoundedJsonObject,
    isAdminOnlySettingKey,
    isKnownSettingKey,
    normalizeSettingValue,
    setImmediate,
    defaultSpawn: '{"position":[0,0,0],"quaternion":[0,0,0,1]}',
    SAVE_INTERVAL: 0,
    // the server's values; tests that wait on them set network.takeoverPingMs / takeoverCloseMs instead
    TAKEOVER_PING_MS: 3000,
    TAKEOVER_CLOSE_MS: 2000,
    process: { env: {} },
    console,
    solanaGating,
    evmGating,
    parseTipAmount,
    tipAmountReason,
    createEvmRpcs,
    createEvmHoldingService,
    readHoldingContractsEnv,
    createTipWatcher,
    formatUnits,
    isTxHash,
    setTimeout,
    clearTimeout,
    clearInterval,
    grantTokenRank,
    rankStored,
    revokeTokenRank,
    createUserRows,
    createSolanaRpc,
    createTokenBalanceService,
    Ranks,
    hasRank,
    isExternalUrl,
    sanitizeAppModify,
    sanitizeAppRelease,
    sanitizeEntityAdd,
    sanitizePlayerSelfModify,
    sanitizeName,
    sanitizePersistedApp,
    sanitizeSpawn,
    sessionAvatarRequest,
    sanitizeChatMessage,
    appChatLine,
    eventPayload,
    internalEvents,
    isObject: value => value !== null && typeof value === 'object',
    ...context,
  })
}
const socketSource = fs.readFileSync(new URL('../../src/core/Socket.js', import.meta.url), 'utf8')
export const Socket = vm.runInNewContext(`(${socketSource.slice(socketSource.indexOf('class Socket'))})`, {
  writePacket,
})

export function makeNetwork(log = () => {}, { context, tokenBalanceService, evmHoldings, tipWatcher } = {}) {
  const Network = networkClass(context)
  const network = new Network()
  network.init({ tokenBalanceService, evmHoldings, tipWatcher })
  network.isServer = true
  network.id = 0
  network.sockets = new Map()
  network.connecting = new Set()
  network.userIds = new Set()
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
    // no apps unless a test brings its own entities (onDisconnect looks for what the connection held)
    entities: { items: new Map() },
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
    setTimeout,
    clearTimeout,
    TAKEOVER_CLOSE_MS: 2000,
    writePacket,
    SNAPSHOT_CAP,
    SNAPSHOT_STEP_NAMES,
    encodeSnapshot,
    envelopeBytes,
    visitorShortfall,
    joinStateBytes,
    RANKED_RESERVE_PLAYERS,
    GROWTH_RESERVE_BYTES,
    SNAPSHOT_FIXED_BYTES,
    Ranks,
    hasRank,
    isExternalUrl,
    Socket,
    briefError,
    previewValue,
    // a token that fails to verify is taken for a forgery here, not for an expired session (tests of expiry give
    // their own)
    expiredSessionUser: async () => null,
    solanaGating,
    evmGating,
    eventPayload,
    ...context,
  })
}
