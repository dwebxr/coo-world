// Evaluates a file of src/ from its text with its `import` lines taken out and the names it imports given in, for the
// tests of classes that are not the network (cleaner.js, collections.js, ServerAI.js). The network runs as the real
// class instead (test/lib/network.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import * as entityPolicy from '../../src/core/extras/entityModifyPolicy.js'
import * as blueprintPolicy from '../../src/core/extras/blueprintPolicy.js'
import * as assetURL from '../../src/core/extras/assetURL.js'
import * as aiBudget from '../../src/server/aiBudget.js'

class System extends EventEmitter {
  constructor(world) {
    super()
    this.world = world
  }
}

function source(file) {
  return fs.readFileSync(
    process.env.REAL_PHYSX_SOURCE_ROOT
      ? path.join(process.env.REAL_PHYSX_SOURCE_ROOT, 'src', file)
      : new URL(`../../src/${file}`, import.meta.url),
    'utf8'
  )
}

export function load(file, name, extra = {}) {
  // the names the files evaluated here import from these modules (System: ServerAI.js); a test gives the rest
  const dependencies = {
    System,
    ...aiBudget,
    ...entityPolicy,
    ...blueprintPolicy,
    ...assetURL,
    ...extra,
  }
  const code = source(file)
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
    .replace(/^export /gm, '')
  return new Function(...Object.keys(dependencies), `${code}\nreturn ${name}`)(...Object.values(dependencies))
}

// (the persistence tests' world around the network is in persistenceFixture.mjs)
export { appData } from './persistenceFixture.mjs'
