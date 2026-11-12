// How a player holds an effect, for the stand-in players of the tests: what PlayerRemote.setEffect does. The effect
// that was current is over: its callback is taken off, the new effect (or none) is put in place, and then the
// callback runs. (Use as a method: `setEffect: holdEffect`.)
export function holdEffect(effect, onEnd) {
  const ended = this.data.effect ? this.onEffectEnd : null
  this.data.effect = effect ?? null
  this.onEffectEnd = onEnd
  ended?.()
}

// ServerNetwork.reserve for a stand-in network that has broadcast(): the packet is admitted now (null when the
// stand-in's broadcast would answer 'refused': set `network.outcome = 'refused'`), and sent by the function returned.
export function reserveLike(name, data) {
  if (this.outcome === 'refused') return null
  return () => this.broadcast(name, data)
}
