// A listen-only branch on a voice stream, separate from playback (which LiveKit rebuilds through
// setWebAudioPlugins on every level/mute change). MediaStreamSource -> Analyser -> Gain(0) -> destination:
// the silent sink keeps every engine pulling the branch without making it audible.

const FFT_SIZE = 2048 // ~43 ms at 48 kHz: longer than a low voice's pitch period, so RMS does not ripple

export function createVoiceTap(ctx, mediaStream) {
  const source = ctx.createMediaStreamSource(mediaStream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = FFT_SIZE
  const sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(analyser)
  analyser.connect(sink)
  sink.connect(ctx.destination)
  const buffer = new Float32Array(analyser.fftSize)
  let destroyed = false
  return {
    rms() {
      if (destroyed) return 0
      analyser.getFloatTimeDomainData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
      const rms = Math.sqrt(sum / buffer.length)
      return Number.isFinite(rms) ? rms : 0
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      source.disconnect()
      analyser.disconnect()
      sink.disconnect()
    },
  }
}
