let n = 0

const Groups = {}

const Masks = {}

export const Layers = {}

function ensure(group) {
  if (Groups[group] === undefined) {
    Groups[group] = 1 << n
    Masks[group] = 0
    n++
  }
}

function add(group, hits) {
  ensure(group)
  for (const otherGroup of hits) {
    if (!otherGroup) continue
    ensure(otherGroup)
    Masks[group] |= Groups[otherGroup]
    // Masks[otherGroup] |= Groups[group]
  }
}

const playerCollision = (process?.env.PUBLIC_PLAYER_COLLISION || globalThis.env?.PUBLIC_PLAYER_COLLISION) === 'true'

add('camera', ['environment'])
add('player', ['environment', 'prop', playerCollision ? 'player' : null])
add('environment', ['camera', 'player', 'environment', 'prop', 'tool'])
add('prop', ['environment', 'prop'])
add('tool', ['environment', 'prop'])

for (const key in Groups) {
  Layers[key] = {
    group: Groups[key],
    mask: Masks[key],
  }
}

// The layers a node (collider, prim, controller) may be on. `player` is the engine's own, for the players' capsules:
// what is on it is skipped by the checks that keep players from colliding with each other, and is taken for a player
// by what filters on the layer. No script and no model file puts a node there.
export const NODE_LAYERS = Object.freeze(['environment', 'prop', 'tool'])

export function isNodeLayer(value) {
  return NODE_LAYERS.includes(value)
}
