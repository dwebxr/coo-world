import fs from 'fs'
import path from 'path'
import Anthropic, { toFile } from '@anthropic-ai/sdk'
import { OpenAI } from 'openai'

import { System } from './System'
import { hashFile } from '../utils-server'
import { anthropicEffort, anthropicRequest, readAnthropicText } from '../extras/anthropicRequest'
import { assetName, assetRefusal, previewValue } from '../extras/assetURL'
import { AI_REFUSALS, createAiBudget, readAiAction, readAiLimitsEnv } from '../../server/aiBudget'

const prefix = `app.remove(app.get('Block'))
`

const docs = fs.readFileSync(path.join(__dirname, 'public/ai-docs.md'), 'utf8')

/**
 * AI System
 *
 * - Runs on the server
 * - Handles comms with AI apis etc
 *
 */
export class ServerAI extends System {
  constructor(world) {
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
    // how many generations run, and for whom (aiBudget.js; AI_MAX_* in the environment, a bad value throws here)
    this.budget = createAiBudget(readAiLimitsEnv(process.env))
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
  // runs in the background; the place is given back when it ends, however it ends.
  // -> null when it was started (or AI is off), or what to tell the requester when it was refused
  onAction(action, key = 'unknown') {
    if (!this.enabled) return null
    const request = readAiAction(action)
    if (!request) return AI_REFUSALS.invalid
    const place = this.budget.start(key)
    if (!place.ok) return AI_REFUSALS[place.reason]
    console.log(`[ai] ${request.name} for ${previewValue(key, 80)}`)
    this.background(request.name, () => this[request.name](request), place.done)
    return null
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

  // AI の呼び出しは待たずに走らせる。失敗 (API の拒否、廃止されたモデル、通信の失敗) は未処理の
  // 拒否にせず、ここでログに出す
  background(name, run, done) {
    Promise.resolve()
      .then(run)
      .catch(err => console.error(`[ai] ${name} failed: ${err?.message ?? err}`))
      .finally(() => done?.())
  }

  async create({ blueprintId, appId, prompt }) {
    console.log('[ai] creating...')
    // classify prompt to a short descriptive name for the app
    this.background('classify', () => this.classify({ blueprintId, prompt }))
    // send prompt to ai to generate code
    const startAt = performance.now()
    let output = await this.client.create(prompt)
    output = stripCodeFences(output)
    const changelog = [`create: ${prompt}`]
    const code = prefix + writeChangelog(output, changelog)
    const elapsed = (performance.now() - startAt) / 1000
    // console.log(code)
    console.log(`[ai] created in ${elapsed}s`)
    // convert new code to asset
    const file = new File([code], 'script.js', { type: 'text/plain' })
    const fileContent = await file.arrayBuffer()
    const hash = await hashFile(Buffer.from(fileContent))
    const filename = `${hash}.js`
    const url = `asset://${filename}`
    // upload new script asset
    await this.assets.upload(file)
    // announce before rebuilding locally
    const blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, script: url }
    if (this.world.network.stopping || !this.admit(change)) return
    this.world.network.markBlueprintDirty({ ...blueprint, ...change })
    this.world.network.send('blueprintModified', change)
    this.world.blueprints.modify(change)
  }

  async edit({ blueprintId, appId, prompt }) {
    console.log('[ai] editing...')
    // get existing blueprint
    let blueprint = this.world.blueprints.get(blueprintId)
    if (!blueprint) return console.error('[ai] edit blueprint but blueprint not found')
    // get code to edit
    const script = await this.readScript(blueprint)
    // send prompt to ai to generate code
    const startAt = performance.now()
    const code = script.code.replace(prefix, '')
    const changelog = readChangelog(code)
    changelog.push(`edit: ${prompt}`)
    let output = await this.client.edit(code, prompt)
    output = stripCodeFences(output)
    const newCode = prefix + writeChangelog(output, changelog)
    const elapsed = (performance.now() - startAt) / 1000
    console.log(`[ai] edited in ${elapsed}s`)
    // convert new code to asset
    const file = new File([newCode], 'script.js', { type: 'text/plain' })
    const fileContent = await file.arrayBuffer()
    const hash = await hashFile(Buffer.from(fileContent))
    const filename = `${hash}.js`
    const url = `asset://${filename}`
    // upload new script asset
    await this.assets.upload(file)
    // announce before rebuilding locally
    blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, script: url }
    if (this.world.network.stopping || !this.admit(change)) return
    this.world.network.markBlueprintDirty({ ...blueprint, ...change })
    this.world.network.send('blueprintModified', change)
    this.world.blueprints.modify(change)
  }

  async fix({ blueprintId, appId, error }) {
    console.log('[ai] fixing...')
    // get existing blueprint
    let blueprint = this.world.blueprints.get(blueprintId)
    if (!blueprint) return console.error('[ai] fix blueprint but blueprint not found')
    // get code to fix
    const script = await this.readScript(blueprint)
    // send prompt to ai to generate code
    const startAt = performance.now()
    const code = script.code.replace(prefix, '')
    const changelog = readChangelog(code)
    let output = await this.client.fix(code, error)
    output = stripCodeFences(output)
    const newCode = prefix + writeChangelog(output, changelog)
    const elapsed = (performance.now() - startAt) / 1000
    console.log(`[ai] fixed in ${elapsed}s`)
    // convert new code to asset
    const file = new File([newCode], 'script.js', { type: 'text/plain' })
    const fileContent = await file.arrayBuffer() // or file.text() for string
    const hash = await hashFile(Buffer.from(fileContent))
    const filename = `${hash}.js`
    const url = `asset://${filename}`
    // upload new script asset
    await this.assets.upload(file)
    // announce before rebuilding locally
    blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, script: url }
    if (this.world.network.stopping || !this.admit(change)) return
    this.world.network.markBlueprintDirty({ ...blueprint, ...change })
    this.world.network.send('blueprintModified', change)
    this.world.blueprints.modify(change)
  }

  // The script text edit and fix send to the AI provider. Only an asset://<name> script is read, through the
  // loader (which keeps local reads inside the assets directory). Any other value, such as a local path,
  // asset:// traversal or a remote URL, is refused here, before the loader or the provider sees it; background()
  // logs the refusal as the action's failure.
  async readScript(blueprint) {
    if (assetName(blueprint.script) === null) {
      throw assetRefusal('the script is not an asset:// file', blueprint.script)
    }
    let script = this.world.loader.get('script', blueprint.script)
    if (!script) script = await this.world.loader.load('script', blueprint.script)
    return script
  }

  async classify({ blueprintId, prompt }) {
    // get a name for the object
    const name = await this.client.classify(prompt)
    // update name
    const blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, name }
    if (this.world.network.stopping || !this.admit(change)) return
    this.world.network.markBlueprintDirty({ ...blueprint, ...change })
    this.world.network.send('blueprintModified', change)
    this.world.blueprints.modify(change)
  }
}

class OpenAIClient {
  constructor(apiKey, model, effort) {
    this.client = new OpenAI({ apiKey })
    this.model = model
    this.effort = effort
  }

  async create(prompt) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
      input: `Respond with the javascript needed to generate the following:\n\n"${prompt}"`,
    })
    return resp.output_text
  }

  async edit(code, prompt) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      input: `Please edit the code above to satisfy the following request:\n\n"${prompt}"`,
    })
    return resp.output_text
  }

  async fix(code, error) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      input: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`,
    })
    return resp.output_text
  }

  async classify(prompt) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
      input: `Please classify the following prompt:\n\n"${prompt}"`,
    })
    return resp.output_text
  }
}

class AnthropicClient {
  constructor(apiKey, model, effort) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.effort = effort
    // 考える分も max_tokens に数えられるので、本文 (スクリプト) の分と合わせて取る。
    // ストリーミングなしで SDK が受け付ける範囲 (16000)
    this.maxTokens = 16000
  }

  async ask({ system, content, effort = this.effort, maxTokens = this.maxTokens }) {
    const params = anthropicRequest({ model: this.model, effort, maxTokens, system, content })
    const resp = await this.client.beta.messages.create(params)
    return readAnthropicText(resp)
  }

  async create(prompt) {
    return this.ask({
      system: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
      content: `Respond with the javascript needed to generate the following:\n\n"${prompt}"`,
    })
  }

  async edit(code, prompt) {
    return this.ask({
      system: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      content: `Please edit the code above to satisfy the following request:\n\n"${prompt}"`,
    })
  }

  async fix(code, error) {
    return this.ask({
      system: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      content: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`,
    })
  }

  // 短い名前を付けるだけなので、考える量を減らす
  async classify(prompt) {
    return this.ask({
      system: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
      content: `Please classify the following prompt:\n\n"${prompt}"`,
      effort: 'low',
      maxTokens: 4096,
    })
  }
}

class XAIClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey
    this.model = model
    this.url = 'https://api.x.ai/v1/chat/completions'
  }

  async create(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
          },
          {
            role: 'user',
            content: `Respond with the javascript needed to generate the following:\n\n"${prompt}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }

  async edit(code, prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
          {
            role: 'user',
            content: `Please edit the code above to satisfy the following request:\n\n"${prompt}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }

  async fix(code, error) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
          {
            role: 'user',
            content: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }

  async classify(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
          },
          {
            role: 'user',
            content: `Please classify the following prompt:\n\n"${prompt}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }
}

class GoogleClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey
    this.url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  }

  async create(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Respond with the javascript needed to generate the following:\n\n"${prompt}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
  }

  async edit(code, prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Please edit the code above to satisfy the following request:\n\n"${prompt}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
  }

  async fix(code, error) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
  }

  async classify(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Please classify the following prompt:\n\n"${prompt}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
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
  let cleaned = text.trim()
  // regex to match ```js ... ``` or ``` ... ```
  const match = cleaned.match(fencePattern)
  if (match) {
    return match[1] // extract inner code
  }
  return cleaned // return untouched if no fences
}
