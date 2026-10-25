// The root error handler. A client error keeps its 4xx status and the error's own headers (such as
// Content-Range on a 416): fastify's own 400/413/415 body-parser answers, a refused Brotli request body, or a
// non-canonical static path such as `//index.css` (@fastify/static 10 refuses those with 403). Anyone can send
// those in a loop, so a 4xx logs one line without a stack. The line still matters: @fastify/static also answers
// 403, with the cause discarded, when it cannot read a static directory (EIO, EMFILE), so a run of 403s on
// ordinary paths is a storage fault. The query string is never logged (/ws carries the auth token there).
// Everything else is logged with its stack and answered 500 with no body.
const MAX_LOGGED_PATH = 200

export function errorHandler(err, req, reply) {
  const code = err?.statusCode
  if (Number.isInteger(code) && code >= 400 && code < 500) {
    const pathname = String(req.url ?? '').split('?')[0].slice(0, MAX_LOGGED_PATH)
    console.error(`[http] ${code} ${req.method} ${pathname}`)
    if (err.headers && typeof err.headers === 'object') reply.headers(err.headers)
    return reply.status(code).send()
  }
  console.error(err)
  reply.status(500).send()
}
