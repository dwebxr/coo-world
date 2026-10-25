// The root error handler. A client error keeps its 4xx status and is not logged: fastify's own 400/413/415
// body-parser answers, a refused Brotli request body, or a non-canonical static path such as `//index.css`
// (@fastify/static 10 refuses those with 403). Anyone can send those in a loop, so they must not print a stack
// per request. Everything else is logged and answered 500 with no body.
export function errorHandler(err, req, reply) {
  const code = err?.statusCode
  if (Number.isInteger(code) && code >= 400 && code < 500) return reply.status(code).send()
  console.error(err)
  reply.status(500).send()
}
