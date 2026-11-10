// Test-only: lets a suite ask the server process what it still holds after a full garbage collection.
//
// Resident memory (what `/server stats` reports) says little about what a server keeps: garbage stays resident
// until the collector runs, and the collector runs later on a busy machine. A check built on it fails when the
// machine is loaded and passes when it is idle. This probe collects first and then reports the heap and the
// memory behind buffers, which is what a leak grows.
//
// startServer({ memoryProbe: true }) preloads this file (node --import) and starts node with --expose-gc. On
// SIGUSR2 the process collects twice, with a turn of the event loop in between so that what the first pass
// released through finalizers is freed by the second, and prints one line:
//   E2E_MEMORY {"n":1,"heapUsed":…,"external":…,"rss":…}      (bytes; `external` includes ArrayBuffers)
// server.retainedMB() sends the signal and reads the line.
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
