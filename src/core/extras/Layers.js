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

// The layers a script may put a node (collider, prim, controller) on. `player` is the engine's own, for the capsules
// of the other players (PlayerRemote makes its collider there): a script's handle refuses it, and so does the reader
// of a model file's custom properties (glbToNodes.js), so that a model cannot do what a script may not. It carries no
// authority (who a collider belongs to comes from its entity, not its layer); the point is one rule for both ways in.
export const NODE_LAYERS = Object.freeze(['environment', 'prop', 'tool'])

export function isNodeLayer(value) {
  return NODE_LAYERS.includes(value)
}
