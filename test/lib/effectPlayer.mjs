// How a player holds an effect, for the stand-in players of the tests: what PlayerRemote.setEffect does. The effect
// that was current is over: its callback is taken off, the new effect (or none) is put in place, and then the
// callback runs. (Use as a method: `setEffect: holdEffect`.)
export function holdEffect(effect, onEnd) {
  const ended = this.data.effect ? this.onEffectEnd : null
  this.data.effect = effect ?? null
  this.onEffectEnd = onEnd
  ended?.()
}
