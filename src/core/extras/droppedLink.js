// A link dropped on the world (ClientBuilder) is fetched and taken as a file. The answer was taken whatever it was:
// an error page became the "file", and a body of any size was read into memory before the size check that a dropped
// file gets. Now an answer that is not a success is refused, and so is a body larger than `maxBytes` (the upload
// limit): by its declared length before any of it is read, and otherwise while it is read, which stops at the chunk
// that passes the limit. With no limit known (`maxBytes` not a number) nothing is refused for its size, as before.
export const LINK_TOO_LARGE = 'LINK_TOO_LARGE'

export async function fetchDroppedLink(url, maxBytes, fetchLink = fetch) {
  const resp = await fetchLink(url)
  const give = async err => {
    try {
      await resp.body?.cancel()
    } catch {
      // (a body that cannot be cancelled is left to the browser)
    }
    return err
  }
  if (!resp.ok) throw await give(new Error(`the dropped link answered ${resp.status}`))
  const tooLarge = () =>
    Object.assign(new Error('the dropped link is larger than an upload may be'), { code: LINK_TOO_LARGE })
  if (Number(resp.headers.get('content-length')) > maxBytes) throw await give(tooLarge())
  const chunks = []
  if (resp.body) {
    const reader = resp.body.getReader()
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // (as above)
        }
        throw tooLarge()
      }
      chunks.push(value)
    }
  }
  return new File(chunks, new URL(url).pathname.split('/').pop(), { type: resp.headers.get('content-type') ?? '' })
}
