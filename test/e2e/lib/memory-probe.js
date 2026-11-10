// Test-only: lets a suite ask the server process how much heap and buffer memory it holds after a full garbage
// collection, so that a check can bound how much `heapUsed + external` grows (the flood step, A12 in fullstack.mjs).
//
// Resident memory (what `/server stats` reports) was the earlier measure and misled both ways: it counts garbage the
// collector has not reached yet, which on a busy machine is a lot, and it stays high even after a collection,
// because V8 keeps the freed heap capacity and the allocator keeps fragmented pages. `heapUsed` and `external` after
// a collection grow only with what the process still holds: JS objects and strings, and the memory behind Buffers
// and ArrayBuffers. They do not see native allocations that V8 is not told about, pages the allocator keeps, or
// kernel socket buffers, so a check built on them bounds the JS-visible part only.
//
// startServer({ memoryProbe: true }) preloads this file (node --import), starts node with --expose-gc and opens an
// IPC channel. On a message { type: 'e2e-memory', id } the process collects twice, with a turn of the event loop in
// between so that what the first pass released through finalizers is freed by the second, and replies with
//   { type: 'e2e-memory', id, heapUsed, external, rss }
// in bytes (`external` includes ArrayBuffers). Other messages are ignored. memoryReader() in memory.mjs sends the
// requests and matches the replies by id.
;(() => {
  // taken now: the engine locks the globals down when it starts
  const collect = globalThis.gc
  if (typeof collect !== 'function') throw new Error('memory-probe.js needs node --expose-gc')
  process.on('message', message => {
    if (message === null || typeof message !== 'object' || message.type !== 'e2e-memory') return
    const { id } = message
    collect()
    setImmediate(() => {
      collect()
      const { heapUsed, external, rss } = process.memoryUsage()
      // the callback keeps a closed channel (the harness has gone) from becoming an 'error' event
      if (process.connected) process.send({ type: 'e2e-memory', id, heapUsed, external, rss }, () => {})
    })
  })
  // the channel must not keep the server alive when it shuts down
  process.channel?.unref()
})()
