import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Match stageContainment's bundling of the runtime's extensionless modules.
export async function bundleProbe(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-probe-'))
  const outfile = path.join(dir, 'probe.mjs')
  await esbuild.build({
    stdin: { contents, resolveDir: root, sourcefile: 'probe-entry.js' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['*physx-js-webidl.js'],
    define: { 'process.env.CLIENT': 'false', 'process.env.SERVER': 'true' },
    logLevel: 'silent',
  })
  return {
    url: pathToFileURL(outfile).href,
    destroy: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

export function runProbe(bundle, probe, args) {
  const source = `
    import assert from 'node:assert/strict'
    import { parentPort, workerData } from 'node:worker_threads'
    globalThis.self = { postMessage() {} }
    if (workerData.args?.browser) globalThis.window = {}
    const module = await import(workerData.url)
    await (${probe.toString()})(module, workerData.args)
    parentPort.postMessage('done')
  `
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      workerData: { url: bundle.url, args },
    })
    let settled = false
    const finish = async error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      await worker.terminate()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('worker probe exceeded 2 s deadline')), 2000)
    worker.once('message', () => finish())
    worker.once('error', finish)
    worker.once('exit', code => finish(new Error(`worker exited before completing probe (${code})`)))
  })
}
