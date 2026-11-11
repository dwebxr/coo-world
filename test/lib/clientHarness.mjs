import fs from 'node:fs'
import { createTokenBalanceClient } from '../../src/core/extras/tokenBalanceClient.js'
import { internalEvents } from '../../src/core/extras/internalEvents.js'
import { EventEmitter } from 'node:events'
import * as THREE from 'three'
import { isEqual, cloneDeep, isArray, isBoolean, isFunction, isNumber } from 'lodash-es'
import moment from 'moment'
import { uuid, createDispatchQueue } from '../../src/core/utils.js'
import { createUploadQueue } from '../../src/core/extras/uploadQueue.js'
import { writeClientPacket, writePacket } from '../../src/core/packets.js'
import { readScriptData } from '../../src/core/extras/scriptData.js'
import { toEngineNumber, toEngineOrder } from '../../src/core/extras/engineNumber.js'
import { BUILDER_ONLY_PACKETS, packetByteLimit, packetNodeLimit } from '../../src/core/extras/inboundPolicy.js'
import { strictDecode } from '../../src/core/extras/strictDecode.js'
import { CHANGE_TOO_LARGE, preflightPacket } from '../../src/core/extras/clientPreflight.js'
import {
  sanitizeBlueprintAdd,
  sanitizeBlueprintModify,
  WORLD_BLUEPRINT_BYTES,
} from '../../src/core/extras/blueprintPolicy.js'
import { CHAT_BODY_MAX_LENGTH, chatEnvelope, cutText, sanitizeChatMessage } from '../../src/core/extras/chatPolicy.js'
import { sanitizeName, sanitizePlayerSelfModify, isEmoteUrl } from '../../src/core/extras/entityModifyPolicy.js'
import { normalizeSettingValue } from '../../src/core/extras/settingsPolicy.js'
import { createEventLedger } from '../../src/core/extras/appEventQueue.js'
import { applyInitials, copyFields, copyProps } from '../../src/core/extras/appFields.js'
import { scriptChatMessage } from '../../src/core/extras/chatPolicy.js'
import { createLogOnce } from '../../src/core/extras/logOnce.js'
import { callForScript, toScriptError } from '../../src/core/extras/scriptValues.js'
import { stoppedError } from '../../src/core/extras/physicsFailure.js'
import { eventPayload } from '../../src/core/extras/eventPayload.js'
import { Ranks } from '../../src/core/extras/ranks.js'
import {
  NODE_CLIMB_LIMIT,
  NODE_LIMIT,
  NodeLimitError,
  assertMovableRoot,
  placeWorldNode,
  treeApp,
  unplaceWorldNode,
} from '../../src/core/extras/nodeLimits.js'
import * as assetURL from '../../src/core/extras/assetURL.js'
import * as runTeardown from '../../src/core/extras/runTeardown.js'
import { revokeRunObjectURLs } from '../../src/core/extras/scriptBlob.js'
import { isPrimitive } from '../../src/core/extras/scriptPrimitives.js'
import { jsonCopy } from '../../src/core/extras/scriptText.js'
import * as joinBudget from '../../src/core/extras/joinBudget.js'
import { resolveAssetFile } from '../../src/core/extras/resolveAssetFile.js'
import { createOutboundFetch, OutboundError } from '../../src/core/extras/outboundFetch.js'
import { LoadingManager } from 'three'
import * as gltfLimits from '../../src/core/extras/gltfLimits.js'

class System extends EventEmitter {
  constructor(world) {
    super()
    this.world = world
  }
}

// Run the actual classes with explicit dependencies, without booting the renderer, physics or storage.
// Use the host realm so the policies' plain-object checks match production.
export function loadClient(file, name, context = {}) {
  const source = fs.readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
  const dependencies = {
    System,
    Entity: class {},
    THREE,
    DEG2RAD: Math.PI / 180,
    RAD2DEG: 180 / Math.PI,
    isEqual,
    cloneDeep,
    isArray,
    isFunction,
    isBoolean,
    isNumber,
    moment,
    uuid,
    createDispatchQueue,
    createUploadQueue,
    createTokenBalanceClient,
    writeClientPacket,
    writePacket,
    readScriptData,
    toEngineNumber,
    toEngineOrder,
    // (the classes run here hold stand-in nodes; the transform guard is Node.js's, run through the sweep's bundle)
    guardTransform() {},
    WORLD_BLUEPRINT_BYTES,
    BUILDER_ONLY_PACKETS,
    packetByteLimit,
    packetNodeLimit,
    strictDecode,
    CHANGE_TOO_LARGE,
    preflightPacket,
    sanitizeBlueprintAdd,
    sanitizeBlueprintModify,
    CHAT_BODY_MAX_LENGTH,
    chatEnvelope,
    cutText,
    sanitizeChatMessage,
    sanitizeName,
    sanitizePlayerSelfModify,
    isEmoteUrl,
    normalizeSettingValue,
    createEventLedger,
    internalEvents,
    applyInitials,
    copyFields,
    copyProps,
    scriptChatMessage,
    createLogOnce,
    toScriptError,
    callForScript,
    stoppedError,
    eventPayload,
    Ranks,
    NODE_CLIMB_LIMIT,
    NodeLimitError,
    placeWorldNode,
    unplaceWorldNode,
    assertMovableRoot,
    treeApp,
    NODE_LIMIT,
    ...runTeardown,
    revokeRunObjectURLs,
    isPrimitive,
    jsonCopy,
    ...assetURL,
    ...joinBudget,
    resolveAssetFile,
    createOutboundFetch,
    OutboundError,
    LoadingManager,
    ...gltfLimits,
    ...context,
  }
  const code = source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '').replace(/^export /gm, '')
  return new Function(...Object.keys(dependencies), `${code}\nreturn ${name}`)(...Object.values(dependencies))
}

export const ClientNetwork = loadClient('core/systems/ClientNetwork.js', 'ClientNetwork')
export const Blueprints = loadClient('core/systems/Blueprints.js', 'Blueprints')

export function clientWorld() {
  const world = new EventEmitter()
  world.entities = { items: new Map() }
  world.network = new ClientNetwork(world)
  world.network.id = 'player'
  world.packets = []
  world.network.ws = { send: packet => world.packets.push(Uint8Array.from(packet)) }
  world.toasts = []
  world.on('toast', text => world.toasts.push(text))
  world.blueprints = new Blueprints(world)
  return world
}
