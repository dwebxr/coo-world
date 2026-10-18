const CACHE_MS = 5000
const TIMEOUT_MS = 10000
const MAX_ID = 0x7fffffff

export function createTokenBalanceClient({ send, isVerified, onChange = () => {}, now = Date.now }) {
  let generation = 0
  let nextId = 0
  let pending = null
  let cache = null
  let disposed = false
  const unknown = () => Object.freeze({ verified: !!isVerified(), known: false, balance: 0 })

  function finish(request, value, cacheable) {
    if (pending !== request) return
    clearTimeout(request.timer)
    pending = null
    if (cacheable) cache = { value, at: now() }
    request.resolve(value)
    onChange()
  }

  function invalidate() {
    generation++
    cache = null
    if (pending) finish(pending, unknown(), false)
    else onChange()
  }

  return {
    peek() {
      return !disposed && cache && now() - cache.at < CACHE_MS ? cache.value : unknown()
    },
    get({ refresh = false } = {}) {
      if (disposed || !isVerified()) return Promise.resolve(unknown())
      if (pending) return pending.promise
      if (!refresh && cache && now() - cache.at < CACHE_MS) return Promise.resolve(cache.value)
      // Never reuse a wire id within this socket, even after invalidation.
      if (nextId === MAX_ID) return Promise.resolve(unknown())
      const request = { id: ++nextId, generation }
      request.promise = new Promise(resolve => {
        request.resolve = resolve
      })
      pending = request
      request.timer = setTimeout(() => finish(request, unknown(), true), TIMEOUT_MS)
      try {
        if (send('tokenBalanceRequest', { id: request.id }) !== true) finish(request, unknown(), true)
      } catch {
        finish(request, unknown(), true)
      }
      return request.promise
    },
    onTokenBalance(data) {
      const request = pending
      if (!request || request.generation !== generation || data?.id !== request.id) return
      if (typeof data.verified !== 'boolean' || typeof data.known !== 'boolean') return
      if (!Number.isFinite(data.balance) || data.balance < 0) return
      if (data.known && !data.verified) return
      const verified = data.verified && !!isVerified()
      const known = verified && data.known
      finish(request, Object.freeze({ verified, known, balance: known ? data.balance : 0 }), true)
    },
    invalidate,
    dispose() {
      disposed = true
      invalidate()
    },
  }
}
