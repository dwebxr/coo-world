// Mouth morphs for VRM avatar instances.
//
// Expression binds from three-vrm point at the meshes of the TEMPLATE scene, which every avatar instance
// clones. Writing through the expression manager would move the template (and so no visible avatar), so
// the binds are recorded by traversal index once per factory and resolved against each clone's own meshes.

// the first preset with a usable bind drives the mouth (VRM 0.x a/o/u/i/e load as aa/oh/ou/ih/ee)
const MOUTH_PRESETS = ['aa', 'oh', 'ou', 'ih', 'ee']

function usableIndex(mesh, index) {
  return Number.isInteger(index) && index >= 0 && index < (mesh?.morphTargetInfluences?.length ?? 0)
}

// [{ objectIndex, morphIndex, weight }] for the template scene, or [] when the model has no mouth
export function collectMouthBinds(expressionManager, templateScene) {
  if (!expressionManager?.getExpression || !templateScene) return []
  const indexOf = new Map()
  let i = 0
  templateScene.traverse(object => indexOf.set(object, i++))
  for (const preset of MOUTH_PRESETS) {
    const weights = new Map() // `${objectIndex}:${morphIndex}` -> summed weight
    for (const bind of expressionManager.getExpression(preset)?.binds ?? []) {
      if (!Array.isArray(bind?.primitives) || !Number.isFinite(bind.weight)) continue
      for (const mesh of bind.primitives) {
        const objectIndex = indexOf.get(mesh)
        if (objectIndex === undefined || !usableIndex(mesh, bind.index)) continue
        const key = `${objectIndex}:${bind.index}`
        weights.set(key, (weights.get(key) ?? 0) + bind.weight)
      }
    }
    const binds = []
    for (const [key, sum] of weights) {
      const weight = Math.min(Math.max(sum, 0), 1)
      if (!weight) continue
      const [objectIndex, morphIndex] = key.split(':').map(Number)
      binds.push({ objectIndex, morphIndex, weight })
    }
    if (binds.length) return binds
  }
  return []
}

// resolves the binds against a clone that still has the template's hierarchy. set() assigns, so nothing
// else may write these morphs; it writes only when the clamped value changes
export function createMouth(cloneScene, binds) {
  const objects = []
  if (binds.length) cloneScene.traverse(object => objects.push(object))
  let targets = []
  for (const { objectIndex, morphIndex, weight } of binds) {
    const mesh = objects[objectIndex]
    if (mesh?.isMesh && usableIndex(mesh, morphIndex)) targets.push({ mesh, morphIndex, weight })
  }
  // unset until the first call: a model may load its mouth morph non-zero, so the first value always writes
  let last = NaN
  const write = value => {
    for (const { mesh, morphIndex, weight } of targets) mesh.morphTargetInfluences[morphIndex] = weight * value
    last = value
  }
  return {
    set(value) {
      const v = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
      if (v === last) return
      write(v)
    },
    reset() {
      write(0)
    },
    dispose() {
      targets = []
    },
  }
}
