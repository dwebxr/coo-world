import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import moment from 'moment'
import * as entityPolicy from '../../src/core/extras/entityModifyPolicy.js'
import * as blueprintPolicy from '../../src/core/extras/blueprintPolicy.js'
import * as settingsPolicy from '../../src/core/extras/settingsPolicy.js'
import * as assetURL from '../../src/core/extras/assetURL.js'
import * as joinBudget from '../../src/core/extras/joinBudget.js'
import { appPersistenceData, persistenceRecord } from '../../src/core/extras/persistenceRecord.js'
import { createInboundGate, createInboundScheduler } from '../../src/core/extras/inboundPolicy.js'
import { createWriteLedger, SNAPSHOT_CAP } from '../../src/core/extras/writeLedger.js'
import { briefError, createLogOnce } from '../../src/core/extras/logOnce.js'
import { cloneDeep } from 'lodash-es'
import { createRelayDrop } from '../../src/core/extras/playerRelayPolicy.js'
import { uuid } from '../../src/core/utils.js'
import { Ranks } from '../../src/core/extras/ranks.js'
import { eventPayload } from '../../src/core/extras/eventPayload.js'
import { appChatLine } from '../../src/core/extras/chatPolicy.js'
import { adminMode, adminWaitScale, createAdminGate } from '../../src/server/adminCode.js'
import { createKickList, readKickEnv } from '../../src/server/kickList.js'
import { createActionBudgets } from '../../src/core/extras/actionBudget.js'
import { isAdminCommand, readCommandPacket } from '../../src/core/extras/chatCommand.js'
import { createUserRows } from '../../src/server/userRows.js'
import { endGrantByDecision } from '../../src/server/rankGrants.js'
import * as aiBudget from '../../src/server/aiBudget.js'

class System extends EventEmitter {
  constructor(world) {
    super()
    this.world = world
  }
}

export function source(file) {
  return fs.readFileSync(
    process.env.REAL_PHYSX_SOURCE_ROOT
      ? path.join(process.env.REAL_PHYSX_SOURCE_ROOT, 'src', file)
      : new URL(`../../src/${file}`, import.meta.url),
    'utf8'
  )
}

export function load(file, name, extra = {}) {
  const dependencies = {
    System,
    ...aiBudget,
    App: class {},
    PlayerLocal: class {},
    PlayerRemote: class {},
    moment,
    cloneDeep,
    appPersistenceData,
    persistenceRecord,
    createInboundGate,
    createInboundScheduler,
    createWriteLedger,
    SNAPSHOT_CAP,
    createRelayDrop,
    uuid,
    createLogOnce,
    briefError,
    Ranks,
    eventPayload,
    appChatLine,
    adminMode,
    adminWaitScale,
    createAdminGate,
    createKickList,
    readKickEnv,
    createActionBudgets,
    isAdminCommand,
    readCommandPacket,
    createUserRows,
    endGrantByDecision,
    ...entityPolicy,
    ...blueprintPolicy,
    ...settingsPolicy,
    ...assetURL,
    ...joinBudget,
    ...extra,
  }
  const code = source(file)
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
    .replace(/^export /gm, '')
  return new Function(...Object.keys(dependencies), `${code}\nreturn ${name}`)(...Object.values(dependencies))
}

export const Settings = load('core/systems/Settings.js', 'Settings')
export const Entities = load('core/systems/Entities.js', 'Entities')

// (the network itself, and the persistence tests' world around it, are in network.mjs and persistenceFixture.mjs)
export { appData } from './persistenceFixture.mjs'
