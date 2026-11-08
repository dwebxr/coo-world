// 投げゼニの tx がチェーンで確定するまで見張る (サーバー専用)。
// - タイマーは 1 本の共有ループで、ジョブが無い時は止まる
// - RPC は全体で 1 つの予算 (トークンバケット、同時数、1 回ごとの期限) から使う。予算が無ければ待つだけで失敗にしない
// - 確定済みブロック ('finalized') は 1 周期に 1 回だけ取り、確定待ちのジョブで共有する
// - 時計とタイマーは注入できる (テスト用)
import { RpcError } from './evmRpc.js'
import { checkTipBlock, finalizedNumber, matchTipReceipt } from './evmTipVerify.js'

class OverBudget extends Error {}
class NoFinality extends Error {}

// 結果: { state: 'confirmed' } / { state: 'failed', reason: reverted | no_transfer | too_old } /
// { state: 'unverified', reason: not_found | timeout | no_finality | left }
export function createTipWatcher({
  rpc,
  now = Date.now,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  log = console,
  tickMs = 1_000,
  fastMs = 3_000,
  slowMs = 10_000,
  fastWindowMs = 30_000,
  deadlineMs = 180_000,
  notFoundAfterMs = 60_000,
  callTimeoutMs = 5_000,
  maxConcurrentCalls = 4,
  ratePerSecond = 8,
  burst = 16,
  finalityRecheckMs = 60_000,
}) {
  const entries = new Set()
  let timer = null
  let stopped = false
  let active = 0
  let tokens = burst
  let bucketAt = now()
  // 確定済みブロック: この周期の取得 (Promise) と、タグが使えないと分かった時刻
  let finalizedTick = -1
  let finalizedPromise = null
  let unsupportedAt = null
  let unsupportedLogged = false
  let tickCount = 0

  // 飛んでいるすべての呼び出し (停止で中断する。ジョブ別の分は cancel 用に entry.controllers にも入る)
  const inFlight = new Set()

  const gone = entry => stopped || !entries.has(entry)

  async function call(entry, method, params) {
    const at = now()
    tokens = Math.min(burst, tokens + (Math.max(0, at - bucketAt) * ratePerSecond) / 1000)
    bucketAt = at
    if (active >= maxConcurrentCalls || tokens < 1) throw new OverBudget()
    tokens--
    active++
    if (entry) entry.polledAt = at
    const controller = new AbortController()
    inFlight.add(controller)
    if (entry) entry.controllers.add(controller)
    const deadline = setTimeout(() => controller.abort(), callTimeoutMs)
    try {
      return await rpc.call(method, params, controller.signal)
    } finally {
      // 枠は呼び出しが本当に終わるまで持つ (止まった呼び出しで同時数を超えない)
      clearTimeout(deadline)
      active--
      inFlight.delete(controller)
      if (entry) entry.controllers.delete(controller)
    }
  }

  // この周期の確定済みブロック番号 (BigInt)。タグが使えなければ NoFinality、ほかの失敗は通常の例外
  function finalized() {
    if (unsupportedAt !== null && now() - unsupportedAt < finalityRecheckMs) return Promise.reject(new NoFinality())
    if (finalizedTick === tickCount && finalizedPromise) return finalizedPromise
    finalizedTick = tickCount
    finalizedPromise = (async () => {
      let block
      try {
        block = await call(null, 'eth_getBlockByNumber', ['finalized', false])
      } catch (err) {
        if (err instanceof RpcError) throw unsupported()
        throw err
      }
      // null はノードの一時的な答え (まだ確定ブロックが無い等) として次の周期に回す。形の悪いブロックは未対応
      if (block === null) throw new Error('no finalized block yet')
      const number = finalizedNumber(block)
      if (number === null) throw unsupported()
      unsupportedAt = null
      return number
    })()
    // 待つジョブが無くても未処理の拒否にしない
    finalizedPromise.catch(() => {})
    return finalizedPromise
  }

  function unsupported() {
    unsupportedAt = now()
    if (!unsupportedLogged) {
      unsupportedLogged = true
      log.error('[evmTips] the RPC does not answer the finalized block tag; tips stay unconfirmed')
    }
    return new NoFinality()
  }

  function finish(entry, result) {
    if (gone(entry)) return
    entries.delete(entry)
    for (const controller of entry.controllers) controller.abort()
    try {
      entry.job.onDone(Object.freeze({ ...result }))
    } catch (err) {
      log.error('[evmTips] a tip result handler failed', err)
    }
  }

  function retry(entry, delay) {
    if (gone(entry)) return
    const age = now() - entry.startedAt
    entry.nextAt = now() + (delay ?? (age < fastWindowMs ? fastMs : slowMs))
  }

  // 予算が無くて呼べなかった: 確認の間隔を進めず、次の周期に回す (長く待っているジョブから順に呼ばれる)
  const deferred = (entry, err) => (err instanceof OverBudget ? retry(entry, tickMs) : retry(entry))

  async function stepReceipt(entry) {
    const { job } = entry
    let receipt
    try {
      receipt = await call(entry, 'eth_getTransactionReceipt', [job.txHash])
    } catch (err) {
      return deferred(entry, err)
    }
    if (gone(entry)) return
    const result = matchTipReceipt(receipt, job)
    if (result.state === 'pending') {
      if (!entry.lookedUp && now() - entry.startedAt >= notFoundAfterMs) {
        // しばらくしてもレシートが無い: ノードがその tx を知らなければ早めに打ち切る
        let tx
        try {
          tx = await call(entry, 'eth_getTransactionByHash', [job.txHash])
        } catch (err) {
          return deferred(entry, err)
        }
        if (gone(entry)) return
        entry.lookedUp = true
        if (tx === null) return finish(entry, { state: 'unverified', reason: 'not_found' })
      }
      return retry(entry)
    }
    if (result.state === 'failed') {
      // 形の悪いレシートは RPC 側の問題かもしれないので、期限まで取り直す
      if (result.reason === 'bad_receipt') return retry(entry)
      return finish(entry, { state: 'failed', reason: result.reason })
    }
    entry.stage = 'final'
    entry.matched = result
    entry.nextAt = now()
  }

  async function stepFinal(entry) {
    const { job, matched } = entry
    let number
    try {
      number = await finalized()
    } catch (err) {
      if (err instanceof NoFinality) return finish(entry, { state: 'unverified', reason: 'no_finality' })
      return retry(entry, err instanceof OverBudget ? tickMs : fastMs)
    }
    if (gone(entry)) return
    if (number < matched.blockNumber) return retry(entry, fastMs)
    let block
    try {
      block = await call(entry, 'eth_getBlockByNumber', [`0x${matched.blockNumber.toString(16)}`, false])
    } catch (err) {
      return retry(entry, err instanceof OverBudget ? tickMs : fastMs)
    }
    if (gone(entry)) return
    const check = checkTipBlock(block, { ...matched, notBeforeSec: job.notBeforeSec })
    if (check === 'ok') return finish(entry, { state: 'confirmed' })
    if (check === 'too_old') return finish(entry, { state: 'failed', reason: 'too_old' })
    if (check === 'reorged') {
      // 同じ高さに別のブロック: tx がどこに入ったかをレシートから見直す
      entry.stage = 'receipt'
      entry.matched = null
      return retry(entry, fastMs)
    }
    retry(entry, fastMs)
  }

  async function step(entry) {
    entry.busy = true
    try {
      await (entry.stage === 'final' ? stepFinal(entry) : stepReceipt(entry))
    } catch (err) {
      log.error('[evmTips] tip check failed', err)
      retry(entry)
    } finally {
      entry.busy = false
    }
  }

  function tick() {
    timer = null
    if (stopped) return
    tickCount++
    const at = now()
    const due = []
    for (const entry of [...entries]) {
      if (entry.busy || gone(entry)) continue
      if (at - entry.startedAt >= deadlineMs) {
        finish(entry, { state: 'unverified', reason: 'timeout' })
        continue
      }
      let live = false
      try {
        live = entry.job.isLive() === true
      } catch {
        live = false
      }
      if (!live) {
        finish(entry, { state: 'unverified', reason: 'left' })
        continue
      }
      if (at >= entry.nextAt) due.push(entry)
    }
    // 予算を公平に回す: 最後に RPC を呼べてから長いジョブから
    due.sort((a, b) => a.polledAt - b.polledAt)
    for (const entry of due) step(entry)
    schedule()
  }

  function schedule() {
    if (timer || stopped || !entries.size) return
    timer = setTimeout(tick, tickMs)
  }

  return {
    // job: { txHash, from, recipient, token, units, notBeforeSec, isLive(), onDone(result) }
    watch(job) {
      if (stopped) return false
      const at = now()
      entries.add({
        job,
        stage: 'receipt',
        startedAt: at,
        nextAt: at,
        busy: false,
        polledAt: -Infinity,
        lookedUp: false,
        matched: null,
        controllers: new Set(),
      })
      schedule()
      return true
    },
    // 結果を出さずに外す (送り手の切断など)
    cancel(predicate) {
      for (const entry of [...entries]) {
        if (!predicate(entry.job)) continue
        entries.delete(entry)
        for (const controller of entry.controllers) controller.abort()
      }
    },
    size: () => entries.size,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      for (const controller of inFlight) controller.abort()
      entries.clear()
    },
  }
}
