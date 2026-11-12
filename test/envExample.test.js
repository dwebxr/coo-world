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

test('.env.example: every setting it offers is one that something reads', () => {
  assert.ok(keys.length > 40, 'the keys were found')
  // src/client/public holds build output next to the pages; it is not where a setting is read
  const files = [
    ...sources(path.join(root, 'src')),
    ...sources(path.join(root, 'scripts')),
    path.join(root, 'agent.mjs'),
  ]
    .filter(file => !file.includes(`${path.sep}public${path.sep}`) || file.endsWith('.html'))
    .filter(file => fs.existsSync(file))
  const text = files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
  const unread = [...new Set(keys)].filter(key => {
    if (text.includes(key)) return false
    // a setting with one variable per chain is read by its stem: EVM_RPC_URL_137 as `EVM_RPC_URL_${chainId}`
    const stem = key.replace(/\d+$/, '')
    return !(stem !== key && stem.endsWith('_') && text.includes(stem + '$'))
  })
  // a line nothing reads invites a value nothing uses; SOLANA_PKEY_ARRAY asked for a wallet's private key
  assert.deepEqual(unread, [])
})

test('.env.example: token gating is off as copied, and its amount is one the server accepts', () => {
  const value = key => example.match(new RegExp(`^${key}=([^\\n#]*)`, 'm'))?.[1].trim()
  assert.equal(value('PUBLIC_TOKEN_MINT'), '', 'a copied file does not gate on a token its world never chose')
  assert.equal(value('SOLANA_RPC_URL'), '')
  assert.equal(parseRequiredTokenAmount(value('PUBLIC_REQUIRED_TOKEN_AMOUNT')), 100000)
  assert.doesNotMatch(example, /PKEY|PRIVATE_KEY|private key/i)
})
