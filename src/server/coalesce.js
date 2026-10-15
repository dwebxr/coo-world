// runs `create` for a key once at a time. a caller arriving while an attempt for the same key is in flight
// waits for it and is told nothing was created; if that attempt fails, the waiter makes its own.
// `inflight` is a Map the caller owns, so each store keeps its own table.
export async function createOnce(inflight, key, create) {
  const pending = inflight.get(key)
  if (pending) {
    try {
      await pending
    } catch (_err) {
      return createOnce(inflight, key, create)
    }
    return false
  }
  const attempt = create()
  inflight.set(key, attempt)
  try {
    return await attempt
  } finally {
    if (inflight.get(key) === attempt) inflight.delete(key)
  }
}
