import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRequiredTokenAmount } from '../src/core/extras/tokenRequirement.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8')

// a setting line, also one that is commented out: `KEY=...` or `# KEY=...`
const keys = [...example.matchAll(/^(?:# ?)?([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1])

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(file, out)
    else if (/\.(js|mjs|html)$/.test(entry.name)) out.push(file)
  }
  return out
}

test('.env.example: every setting it offers is a name the source uses as a whole word', () => {
  assert.ok(keys.length > 40, 'the keys were found')
  // src/client/public holds build output next to the pages; it is not where a setting is read
  const files = [
    ...sources(path.join(root, 'src')),
    ...sources(path.join(root, 'scripts')),
    path.join(root, 'agent.mjs'),
  ]
    .filter(file => !file.includes(`${path.sep}public${path.sep}`) || file.endsWith('.html'))
    .filter(file => fs.existsSync(file))
  // a comment is not a reader: whole-line comments are left out (block comments and a comment after code on its
  // line are not, so this is a floor under the claim, not a parse)
  const text = files
    .map(file => fs.readFileSync(file, 'utf8'))
    .join('\n')
    .replace(/^\s*\/\/.*$/gm, '')
  const used = key => new RegExp(`(?<![A-Za-z0-9_])${key}(?![A-Za-z0-9_])`).test(text)
  // a setting with one variable per chain is read by its stem: EVM_RPC_URL_137 as `EVM_RPC_URL_${chainId}`
  const usedByStem = key => {
    const stem = key.replace(/\d+$/, '')
    return stem !== key && stem.endsWith('_') && new RegExp(`(?<![A-Za-z0-9_])${stem}\\$\\{`).test(text)
  }
  const unread = [...new Set(keys)].filter(key => !used(key) && !usedByStem(key))
  // a line nothing reads invites a value nothing uses; SOLANA_PKEY_ARRAY asked for a wallet's private key
  assert.deepEqual(unread, [])
  // the rule itself: part of a longer name is not a use, and neither is a comment
  assert.equal(used('TOKEN'), false)
  assert.equal(used('PUBLIC_TOKEN'), false)
  assert.equal(used('PUBLIC_TOKEN_MINT'), true)
  assert.equal(usedByStem('EVM_RPC_URL_137'), true)
  assert.equal(usedByStem('SOLANA_RPC_URL_1'), false)
})

test('.env.example: token gating is off as copied, and its amount is one the server accepts', () => {
  const value = key => example.match(new RegExp(`^${key}=([^\\n#]*)`, 'm'))?.[1].trim()
  assert.equal(value('PUBLIC_TOKEN_MINT'), '', 'a copied file does not gate on a token its world never chose')
  assert.equal(value('SOLANA_RPC_URL'), '')
  assert.equal(parseRequiredTokenAmount(value('PUBLIC_REQUIRED_TOKEN_AMOUNT')), 100000)
  assert.doesNotMatch(example, /PKEY|PRIVATE_KEY|private key/i)
})
