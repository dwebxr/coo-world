import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import tls from 'node:tls'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

import { OutboundError, createOutboundFetch } from '../src/core/extras/outboundFetch.js'

// The connection goes to the address that was checked, not to the name, and TLS must still be about the name:
// the name is the server name sent (SNI) and the one the certificate is verified for, and verification stays on.
// A local CA signs a certificate for `pinned.test`; the process trusts that CA alone for this file (its own
// process under node --test). Certificates come from the openssl command; without it the test is skipped.
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const skip = !hasOpenssl
  ? 'openssl is not available'
  : typeof tls.setDefaultCACertificates !== 'function'
    ? 'tls.setDefaultCACertificates is not available'
    : false

let dir
let pem
const servers = []
const seen = []

const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
const key = name => ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', name]

async function listen(cert, keyFile) {
  const server = https.createServer({ cert: pem(cert), key: pem(keyFile) }, (req, res) => {
    seen.push({ servername: req.socket.servername, host: req.headers.host })
    res.end('verified')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return server.address().port
}

before(() => {
  if (skip) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-tls-'))
  pem = name => fs.readFileSync(path.join(dir, name), 'utf8')
  // a CA, a certificate it signs for pinned.test, and a self-signed one for the same name
  openssl(
    'req',
    '-x509',
    ...key('ca.key'),
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=outbound test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign'
  )
  openssl('req', ...key('leaf.key'), '-out', 'leaf.csr', '-subj', '/CN=pinned.test')
  fs.writeFileSync(path.join(dir, 'leaf.ext'), 'subjectAltName=DNS:pinned.test\nextendedKeyUsage=serverAuth\n')
  openssl(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-set_serial',
    '1',
    '-days',
    '2',
    '-extfile',
    'leaf.ext',
    '-out',
    'leaf.pem'
  )
  openssl(
    'req',
    '-x509',
    ...key('self.key'),
    '-out',
    'self.pem',
    '-days',
    '2',
    '-subj',
    '/CN=pinned.test',
    '-addext',
    'subjectAltName=DNS:pinned.test'
  )
  tls.setDefaultCACertificates([pem('ca.pem')])
})

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

const resolver = () => ({
  resolve4: (host, callback) => setImmediate(() => callback(null, ['127.0.0.1'])),
  resolve6: (host, callback) => setImmediate(() => callback(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }))),
  cancel() {},
})
const allowLocal = address => address === '127.0.0.1'
const network = pattern => err => err instanceof OutboundError && err.code === 'network' && pattern.test(err.message)

test(
  'TLS through a pinned address: the name is the server name and the certificate is verified for it',
  { skip },
  async () => {
    const port = await listen('leaf.pem', 'leaf.key')
    const fetch = createOutboundFetch({ resolver, isAllowedAddress: allowLocal })
    assert.equal(await (await fetch(`https://pinned.test:${port}/`)).text(), 'verified')
    assert.deepEqual(seen.at(-1), { servername: 'pinned.test', host: `pinned.test:${port}` })
    // the same server and certificate under another name: refused, although the address is the same one
    await assert.rejects(fetch(`https://other.test:${port}/`), network(/ERR_TLS_CERT_ALTNAME_INVALID/))
    // and verification is on: a certificate no trusted CA signed is refused for the right name too
    const selfSigned = await listen('self.pem', 'self.key')
    await assert.rejects(fetch(`https://pinned.test:${selfSigned}/`), network(/SELF_SIGNED/))
    assert.equal(seen.length, 1)
  }
)
