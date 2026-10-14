import { customAlphabet } from 'nanoid'

const ALPHABET = '1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * UUID
 *
 * We use 10 character uuids for simplicity and balance between probability and network packet size,
 * without the need to use smaller id mapping tech.
 *
 * alphanumeric @ 10 characters
 * ~148 years or 129M IDs needed, in order to have a 1% probability of at least one collision.
 * see: https://zelark.github.io/nano-id-cc/
 *
 */
export const uuid = customAlphabet(ALPHABET, 10)

export function clamp(n, low, high) {
  return Math.max(Math.min(n, high), low)
}

export function num(min, max, dp = 0) {
  const value = Math.random() * (max - min) + min
  return parseFloat(value.toFixed(dp))
}

/**
 * Dispatch Queue
 *
 * FIFO queue used by ServerNetwork/ClientNetwork to buffer incoming packets and
 * drain them one at a time, isolating per-item errors so one bad packet doesn't
 * block the rest of the queue.
 *
 */
export function createDispatchQueue() {
  const queue = []
  function enqueue(...args) {
    queue.push(args)
  }
  function flush(dispatch) {
    while (queue.length) {
      try {
        const result = dispatch(...queue.shift())
        // async handlers reject later; keep those failures contained too
        if (typeof result?.then === 'function') result.then(undefined, err => console.error(err))
      } catch (err) {
        console.error(err)
      }
    }
  }
  return { enqueue, flush }
}
