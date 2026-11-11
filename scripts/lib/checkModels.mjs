// What scripts/check-models.mjs does to one file: the steps a client takes with a model, avatar or emote (the check
// before parsing, then the parse charged to a budget, with the VRM plugin registered), without a renderer.
import { LoadingManager } from 'three'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

import { GLTFLoader } from '../../src/core/libs/gltfloader/GLTFLoader.js'
import { checkGLTF, createGLTFBudget, GLTF_LIMITS, isDataURI } from '../../src/core/extras/gltfLimits.js'

// what the parser expects of a browser; no image is ever decoded here
globalThis.self ??= globalThis
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })

// As on a client and on the server, a file may only use what is inside it: nothing a file names is ever requested
// (an external image is left out, an external buffer was refused by the check already).
function embeddedOnly() {
  const manager = new LoadingManager()
  manager.setURLModifier(url => {
    if (typeof url === 'string' && (isDataURI(url) || url.startsWith('blob:'))) return url
    throw new Error('a model may not load external files')
  })
  return manager
}

// Resolves with what the file used of its limits, or rejects with the refusal. `data`: the file as an ArrayBuffer.
// `maxTextureSize`: a renderer's largest texture size, to charge morph targets as that renderer would; without it
// they are charged at their largest, which is what a client with the largest textures would be charged.
export async function checkModel(data, { maxTextureSize } = {}) {
  const budget = createGLTFBudget({ fileBytes: data.byteLength, maxTextureSize })
  checkGLTF(data, GLTF_LIMITS, budget)
  const loader = new GLTFLoader(embeddedOnly())
  loader.register(parser => new VRMLoaderPlugin(parser))
  await loader.parseAsync(data, '', budget)
  return {
    fileBytes: data.byteLength,
    bytes: budget.used.bytes / budget.maxBytes,
    work: budget.used.work / budget.maxWork,
  }
}
