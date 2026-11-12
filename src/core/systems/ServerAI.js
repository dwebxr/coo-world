import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { OpenAI } from 'openai'

import { System } from './System'
import { hashFile } from '../utils-server'
import { anthropicEffort, anthropicRequest, readAnthropicText } from '../extras/anthropicRequest'
import { assetName, assetRefusal, previewValue } from '../extras/assetURL'
import { AI_REFUSALS, createAiBudget, readAiAction, readAiLimitsEnv } from '../../server/aiBudget'

const prefix = `app.remove(app.get('Block'))
`

const docs = fs.readFileSync(path.join(__dirname, 'public/ai-docs.md'), 'utf8')

// The output limit of a request for a script (create, edit, fix) and of a create's request for a name, in tokens.
// Each client sends it in its API's own parameter. What it covers differs: Anthropic's max_tokens and OpenAI's
// max_output_tokens include the model's thinking or reasoning, xAI's max_completion_tokens does not, and Google's
// reference does not say for maxOutputTokens. A reply cut off at the limit is an error, not a script.
const SCRIPT_MAX_TOKENS = 16000
const NAME_MAX_TOKENS = 4096

// the script of the app ClientAI.create places before it asks: a "generating…" display (src/world/assets/ai.js)
const PLACEHOLDER_SCRIPT = 'asset://ai.js'
// how many placeholder apps of one blueprint refused requests may leave waiting for the actions on it to end
// (ClientAI makes one a blueprint)
const PLACEHOLDERS_WAITING_MAX = 8

/**
 * AI System
 *
 * - Runs on the server
 * - Handles comms with AI apis etc
 *
 */
export class ServerAI extends System {
  // `now`, `setTimer` and `clearTimer` are the clock (milliseconds) and the timer of the deadline (run)
  constructor(world, { now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super(world)
    this.assets = null
    this.provider = process.env.AI_PROVIDER || null
    this.model = process.env.AI_MODEL || null
    this.effort = process.env.AI_EFFORT || 'minimal'
    this.apiKey = process.env.AI_API_KEY || null
    if (this.provider && this.model && this.apiKey) {
      if (this.provider === 'openai') {
        this.client = new OpenAIClient(this.apiKey, this.model, this.effort)
      }
      if (this.provider === 'anthropic') {
        this.client = new AnthropicClient(this.apiKey, this.model, anthropicEffort(process.env.AI_EFFORT))
      }
      if (this.provider === 'xai') {
        this.client = new XAIClient(this.apiKey, this.model)
      }
      if (this.provider === 'google') {
        this.client = new GoogleClient(this.apiKey, this.model)
      }
    }
    this.enabled = !!this.client
    // how many generations run, for whom, and for how long (aiBudget.js; AI_MAX_* in the environment, a bad value
    // throws here)
    const limits = readAiLimitsEnv(process.env)
    this.budget = createAiBudget(limits, { now })
    this.deadlineMs = limits.maxSeconds * 1000
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    // blueprint id -> how many admitted actions run on it
    this.running = new Map()
    // blueprint id -> the placeholder apps whose removal waits for the actions running on it to end
    this.waiting = new Map()
  }

  serialize() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      model: this.model,
      effort: this.effort,
    }
  }

  async init({ assets }) {
    this.assets = assets
  }

  // One `ai` request of a builder. `key` is who it is counted against (the user, or the wallet of a builder by
  // token: ServerNetwork.onAi). The request is read into plain, bounded values, takes a place in the budget, and
  // runs in the background (run); the place is given back when it ends, however it ends.
  // -> null when it was started (or AI is off), or what to tell the requester when it was refused
  onAction(action, key = 'unknown') {
    if (!this.enabled) return null
    const request = readAiAction(action)
    if (!request) return AI_REFUSALS.invalid
    const place = this.budget.start(key)
    if (!place.ok) {
      this.dropPlaceholder(request)
      return AI_REFUSALS[place.reason]
    }
    console.log(`[ai] ${request.name} for ${previewValue(key, 80)}`)
    this.run(request, place.done)
    return null
  }

  // An admitted action, run to its end or to its deadline, whichever comes first. It is everything the action
  // does: reading the script, the provider request with the SDK's own retries, and for a create the naming request
  // too. At the deadline the provider requests are aborted (they take the job's signal); what cannot be aborted
  // (reading the script, an upload) may still finish, and then changes nothing (apply). Either way the place is
  // given back once (`done`), and a create that did not replace its placeholder's script removes the placeholder.
  // A failure is logged here rather than left as an unhandled rejection.
  async run(request, done) {
    const { name, blueprintId } = request
    const controller = new AbortController()
    const job = { signal: controller.signal }
    this.running.set(blueprintId, (this.running.get(blueprintId) || 0) + 1)
    let timer
    const deadline = new Promise(resolve => {
      timer = this.setTimer(() => resolve(true), this.deadlineMs)
      // a deadline alone does not keep the process running
      timer?.unref?.()
    })
    try {
      const work = Promise.resolve().then(() => this[name](request, job))
      if (await Promise.race([work.then(() => false), deadline])) {
        console.error(`[ai] ${name} stopped: it ran past its deadline (${this.deadlineMs / 1000} s)`)
      }
    } catch (err) {
      console.error(`[ai] ${name} failed: ${err?.message ?? err}`)
    } finally {
      this.clearTimer(timer)
      // the job has ended: a request still running is aborted, a late reply is not applied
      controller.abort()
      const left = this.running.get(blueprintId) - 1
      if (left > 0) this.running.set(blueprintId, left)
      else this.running.delete(blueprintId)
      done()
      this.dropPlaceholder(request, true)
      if (left <= 0) {
        // the last action on this blueprint ended: the placeholders that waited for it are decided now, whatever
        // this action was (an edit that failed on a placeholder whose own create had failed before it)
        const waiting = this.waiting.get(blueprintId)
        this.waiting.delete(blueprintId)
        for (const appId of waiting || []) this.dropPlaceholder({ name: 'create', blueprintId, appId })
      }
    }
  }

  // A create's placeholder is the app ClientAI.create adds, with a blueprint of its own, before it asks: it runs
  // PLACEHOLDER_SCRIPT ("generating…") until the generated script replaces the blueprint's. A create that is
  // refused, or that ends without that (a failure, the deadline, a script the world has no room for), would leave
  // it, for everyone, for good. The server removes it, rather than the requester's client on being told: the
  // server knows how every request ends, also after the requester has left, and does not depend on the client
  // being one that cleans up. Only this request's placeholder goes: the action is a create, the app named by
  // appId is of the action's blueprint, that blueprint still runs the placeholder script, and no admitted action
  // runs on it (so a refused request cannot take away the placeholder of one that runs). While one runs, the
  // removal waits for the last of them to end and is decided again then (run). The list is kept only for
  // blueprints with a running action and holds apps that were of that blueprint when the last one was added: the
  // app of every admitted create that ended meanwhile, and a few named by refused requests, which cost nothing to
  // send. A builder may remove any app (ServerNetwork.onEntityRemoved), so this lets no one remove what they could
  // not. The blueprint stays, unused: the protocol has no way to remove a blueprint.
  dropPlaceholder({ name, blueprintId, appId }, admitted = false) {
    if (name !== 'create' || typeof appId !== 'string') return
    if (this.world.blueprints.get(blueprintId)?.script !== PLACEHOLDER_SCRIPT) return
    if (this.world.network.stopping) return
    if (!this.isAppOf(appId, blueprintId)) return
    if (this.running.has(blueprintId)) {
      let waiting = this.waiting.get(blueprintId)
      if (!waiting) this.waiting.set(blueprintId, (waiting = new Set()))
      // what was removed or given another blueprint meanwhile is dropped here, before the next one is added: after
      // an addition the list holds no more than the blueprint's apps, however long actions keep overlapping on it
      for (const id of waiting) if (!this.isAppOf(id, blueprintId)) waiting.delete(id)
      if (admitted || waiting.size < PLACEHOLDERS_WAITING_MAX) waiting.add(appId)
      return
    }
    try {
      this.world.entities.remove(appId)
    } catch (err) {
      console.error(`[ai] placeholder teardown failed: ${err?.message ?? err}`)
      // the app is gone from the world all the same (as in ServerNetwork.rekeyApp)
      this.world.entities.items.delete(appId)
      this.world.entities.untrackApp?.(appId)
    }
    this.world.network.send('entityRemoved', appId)
    console.log(`[ai] placeholder app ${previewValue(appId, 16)} removed`)
  }

  isAppOf(appId, blueprintId) {
    const app = this.world.entities.get(appId)
    return !!app?.isApp && app.data.blueprint === blueprintId
  }

  // A generated change passes the same world budgets as a builder's edit (Blueprints.budgetRefusal: the blueprint
  // budget and the join snapshot's world state); a refused one is logged and not applied
  admit(change) {
    if (this.world.blueprints.canFit(change)) return true
    const refusal = this.world.blueprints.budgetRefusal(change)
    const reason =
      refusal === 'world' ? 'the world is full (join-state budget exceeded)' : 'world blueprint budget exceeded'
    console.warn(`[ai] change to blueprint ${previewValue(change.id, 16)} not applied: ${reason}`)
    return false
  }

  // A generated change is applied and announced only while its job runs (a reply after the deadline changes
  // nothing), not while the server stops, and when it passes the world budgets
  apply(job, blueprintId, fields) {
    if (job.signal.aborted || this.world.network.stopping) return
    const blueprint = this.world.blueprints.get(blueprintId)
    const change = { id: blueprint.id, version: blueprint.version + 1, ...fields }
    if (!this.admit(change)) return
    this.world.network.markBlueprintDirty({ ...blueprint, ...change })
    this.world.network.send('blueprintModified', change)
    this.world.blueprints.modify(change)
  }

  // A generated script, stored as an asset and set as the blueprint's script. Not uploaded once the job has ended.
  async saveScript(job, blueprintId, code) {
    const file = new File([code], 'script.js', { type: 'text/plain' })
    const fileContent = await file.arrayBuffer()
    const hash = await hashFile(Buffer.from(fileContent))
    const url = `asset://${hash}.js`
    if (job.signal.aborted) return
    await this.assets.upload(file)
    this.apply(job, blueprintId, { script: url })
  }

  // The script and its name are asked for at once; the create ends when both have settled, however each ends.
  // A failed naming is logged (the script may still arrive); a failed script fails the create.
  async create({ blueprintId, prompt }, job) {
    console.log('[ai] creating...')
    const [named, made] = await Promise.allSettled([
      this.classify({ blueprintId, prompt }, job),
      this.generate({ blueprintId, prompt }, job),
    ])
    if (named.status === 'rejected' && !job.signal.aborted) {
      console.error(`[ai] classify failed: ${named.reason?.message ?? named.reason}`)
    }
    if (made.status === 'rejected') throw made.reason
  }

  async generate({ blueprintId, prompt }, job) {
    const startAt = this.now()
    let output = await this.client.create(prompt, { signal: job.signal })
    output = stripCodeFences(output)
    const changelog = [`create: ${prompt}`]
    const code = prefix + writeChangelog(output, changelog)
    console.log(`[ai] created in ${(this.now() - startAt) / 1000}s`)
    await this.saveScript(job, blueprintId, code)
  }

  async edit({ blueprintId, prompt }, job) {
    console.log('[ai] editing...')
    // get existing blueprint
    const blueprint = this.world.blueprints.get(blueprintId)
    if (!blueprint) return console.error('[ai] edit blueprint but blueprint not found')
    // get code to edit
    const script = await this.readScript(blueprint)
    // a read that ends after the deadline asks the provider nothing
    if (job.signal.aborted) return
    // send prompt to ai to generate code
    const startAt = this.now()
    const code = script.code.replace(prefix, '')
    const changelog = readChangelog(code)
    changelog.push(`edit: ${prompt}`)
    let output = await this.client.edit(code, prompt, { signal: job.signal })
    output = stripCodeFences(output)
    const newCode = prefix + writeChangelog(output, changelog)
    console.log(`[ai] edited in ${(this.now() - startAt) / 1000}s`)
    await this.saveScript(job, blueprintId, newCode)
  }

  async fix({ blueprintId, error }, job) {
    console.log('[ai] fixing...')
    // get existing blueprint
    const blueprint = this.world.blueprints.get(blueprintId)
    if (!blueprint) return console.error('[ai] fix blueprint but blueprint not found')
    // get code to fix
    const script = await this.readScript(blueprint)
    // a read that ends after the deadline asks the provider nothing
    if (job.signal.aborted) return
    // send prompt to ai to generate code
    const startAt = this.now()
    const code = script.code.replace(prefix, '')
    const changelog = readChangelog(code)
    let output = await this.client.fix(code, error, { signal: job.signal })
    output = stripCodeFences(output)
    const newCode = prefix + writeChangelog(output, changelog)
    console.log(`[ai] fixed in ${(this.now() - startAt) / 1000}s`)
    await this.saveScript(job, blueprintId, newCode)
  }

  // The script text edit and fix send to the AI provider. Only an asset://<name> script is read, through the
  // loader (which keeps local reads inside the assets directory). Any other value, such as a local path,
  // asset:// traversal or a remote URL, is refused here, before the loader or the provider sees it; run() logs
  // the refusal as the action's failure.
  async readScript(blueprint) {
    if (assetName(blueprint.script) === null) {
      throw assetRefusal('the script is not an asset:// file', blueprint.script)
    }
    let script = this.world.loader.get('script', blueprint.script)
    if (!script) script = await this.world.loader.load('script', blueprint.script)
    return script
  }

  async classify({ blueprintId, prompt }, job) {
    // get a name for the object
    const name = await this.client.classify(prompt, { signal: job.signal })
    this.apply(job, blueprintId, { name })
  }
}

// Each client's create, edit, fix and classify take `{ signal }`: aborting it stops the request (ServerAI.run)

const SCRIPT_SYSTEM = `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`
const editSystem = code => `${SCRIPT_SYSTEM}
        Here is the existing script that you will be working with:
        ===============
        ${code}`
const NAME_SYSTEM = `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`
const createInput = prompt => `Respond with the javascript needed to generate the following:\n\n"${prompt}"`
const editInput = prompt => `Please edit the code above to satisfy the following request:\n\n"${prompt}"`
const fixInput = error => `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`
const nameInput = prompt => `Please classify the following prompt:\n\n"${prompt}"`

// The four requests, the same for every provider; `ask` is the provider's own call
class ProviderClient {
  async create(prompt, { signal } = {}) {
    return this.ask({ system: SCRIPT_SYSTEM, content: createInput(prompt), signal })
  }

  async edit(code, prompt, { signal } = {}) {
    return this.ask({ system: editSystem(code), content: editInput(prompt), signal })
  }

  async fix(code, error, { signal } = {}) {
    return this.ask({ system: editSystem(code), content: fixInput(error), signal })
  }

  async classify(prompt, { signal } = {}) {
    return this.ask({ system: NAME_SYSTEM, content: nameInput(prompt), maxTokens: NAME_MAX_TOKENS, signal })
  }
}

// Responses API: max_output_tokens counts the reasoning too; a reply that stopped at it has status 'incomplete'
class OpenAIClient extends ProviderClient {
  constructor(apiKey, model, effort) {
    super()
    this.client = new OpenAI({ apiKey })
    this.model = model
    this.effort = effort
  }

  async ask({ system, content, maxTokens = SCRIPT_MAX_TOKENS, signal }) {
    const resp = await this.client.responses.create(
      {
        model: this.model,
        reasoning: { effort: this.effort },
        // text: { verbosity: 'low' },
        max_output_tokens: maxTokens,
        instructions: system,
        input: content,
      },
      { signal }
    )
    if (resp.status === 'incomplete') {
      throw new Error(`the AI reply was cut off (${resp.incomplete_details?.reason ?? 'incomplete'})`)
    }
    return resp.output_text
  }
}

class AnthropicClient extends ProviderClient {
  constructor(apiKey, model, effort) {
    super()
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.effort = effort
    // 考える分も max_tokens に数えられるので、本文 (スクリプト) の分と合わせて取る。
    // ストリーミングなしで SDK が受け付ける範囲 (16000)
    this.maxTokens = SCRIPT_MAX_TOKENS
  }

  async ask({ system, content, effort = this.effort, maxTokens = this.maxTokens, signal }) {
    const params = anthropicRequest({ model: this.model, effort, maxTokens, system, content })
    const resp = await this.client.beta.messages.create(params, { signal })
    return readAnthropicText(resp)
  }

  // 短い名前を付けるだけなので、考える量を減らす
  async classify(prompt, { signal } = {}) {
    return this.ask({
      system: NAME_SYSTEM,
      content: nameInput(prompt),
      effort: 'low',
      maxTokens: NAME_MAX_TOKENS,
      signal,
    })
  }
}

// Chat Completions: max_completion_tokens counts the visible reply only, not the reasoning (xAI's API reference;
// max_tokens is deprecated there); a reply that stopped at it has finish_reason 'length'
class XAIClient extends ProviderClient {
  constructor(apiKey, model) {
    super()
    this.apiKey = apiKey
    this.model = model
    this.url = 'https://api.x.ai/v1/chat/completions'
  }

  async ask({ system, content, maxTokens = SCRIPT_MAX_TOKENS, signal }) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
      signal,
    })
    const data = await resp.json()
    const choice = data.choices[0]
    if (choice.finish_reason === 'length') throw new Error('the AI reply was cut off (max_completion_tokens)')
    return choice.message.content
  }
}

// generateContent: generationConfig.maxOutputTokens; a reply that stopped at it has finishReason 'MAX_TOKENS'
class GoogleClient extends ProviderClient {
  constructor(apiKey, model) {
    super()
    this.apiKey = apiKey
    this.url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  }

  async ask({ system, content, maxTokens = SCRIPT_MAX_TOKENS, signal }) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: { parts: { text: system } },
        contents: [{ role: 'user', parts: [{ text: content }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
      signal,
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    const candidate = data.candidates[0]
    if (candidate.finishReason === 'MAX_TOKENS') throw new Error('the AI reply was cut off (maxOutputTokens)')
    return candidate.content.parts[0].text
  }
}

const changelogRegex = /\/\*\*[\s\S]*?changelog:[\s\S]*?\*\/\s*/
const entryRegex = /\*\s*-\s*(.+)/g

function readChangelog(code) {
  // match changelog comment block
  const match = code.match(changelogRegex)
  if (!match) return []
  const changelogBlock = match[0]
  // extract individual entries (lines starting with * -)
  const entries = []
  let entryMatch
  while ((entryMatch = entryRegex.exec(changelogBlock)) !== null) {
    entries.push(entryMatch[1].trim())
  }
  return entries
}

function writeChangelog(code, changelog) {
  // remove existing changelog header if exists
  const changelogRegex = /\/\*\*[\s\S]*?changelog:[\s\S]*?\*\/\s*/
  const cleanCode = code.replace(changelogRegex, '')
  // construct new changelog header
  const entries = changelog.map(entry => ` * - ${entry}`).join('\n')
  const header = `/**\n * changelog:\n${entries}\n */\n\n`
  // insert new header at beginning
  return header + cleanCode.trimStart()
}

const fencePattern = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/
function stripCodeFences(text) {
  // sometimes AI responses come back wrapped in code backticks even though
  // we ask it not to. this strips them out if they exist.
  const cleaned = text.trim()
  // regex to match ```js ... ``` or ``` ... ```
  const match = cleaned.match(fencePattern)
  if (match) {
    return match[1] // extract inner code
  }
  return cleaned // return untouched if no fences
}
