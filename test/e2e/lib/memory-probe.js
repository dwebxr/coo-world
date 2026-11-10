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
// startServer({ memoryProbe: true }) preloads this file (node --import) and starts node with --expose-gc. On
// SIGUSR2 the process collects twice, with a turn of the event loop in between so that what the first pass
// released through finalizers is freed by the second, and prints one line on stdout:
//   E2E_MEMORY {"n":1,"heapUsed":…,"external":…,"rss":…}
// in bytes (`external` includes ArrayBuffers), where n counts the signals. server.retainedMiB() sends the signal
// and waits for the line with its number.
;(() => {
  // taken now: the engine locks the globals down when it starts
  const collect = globalThis.gc
  if (typeof collect !== 'function') throw new Error('memory-probe.js needs node --expose-gc')
  let n = 0
  process.on('SIGUSR2', () => {
    collect()
    setImmediate(() => {
      collect()
      const { heapUsed, external, rss } = process.memoryUsage()
      process.stdout.write(`E2E_MEMORY ${JSON.stringify({ n: ++n, heapUsed, external, rss })}\n`)
    })
  })
})()
