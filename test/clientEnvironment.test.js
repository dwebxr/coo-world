import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { isNumber, isString } from 'lodash-es'
import { loadClient } from './lib/clientHarness.mjs'

// The real environment system with a stand-in for its shadow cascades and the loader: what applies when a sky's
// background or HDR fails to load, and which of two skies wins.
class CSM {
  constructor() {
    this.lights = [{ intensity: 0, color: new THREE.Color(), castShadow: true }]
    this.lightDirection = null
  }
  update() {}
  updateCascades() {}
  updateShadowMapSize() {}
  updateFrustums() {}
}
const ClientEnvironment = loadClient('core/systems/ClientEnvironment.js', 'ClientEnvironment', {
  // the sky sphere's bounds tree comes from three-mesh-bvh in the client build
  THREE: {
    ...THREE,
    SphereGeometry: class extends THREE.SphereGeometry {
      computeBoundsTree() {}
    },
  },
  CSM,
  isNumber,
  isString,
})

const tick = () => new Promise(resolve => setImmediate(resolve))
const base = {
  bg: null,
  hdr: null,
  rotationY: 0,
  sunDirection: new THREE.Vector3(0, -1, 0),
  sunIntensity: 1,
  sunColor: '#ffffff',
  fogNear: null,
  fogFar: null,
  fogColor: null,
}

function makeEnvironment(load) {
  const world = {
    stage: { scene: new THREE.Scene() },
    camera: new THREE.PerspectiveCamera(),
    prefs: { shadows: 'med', on() {} },
    graphics: { on() {} },
    rig: { position: new THREE.Vector3() },
    loader: { load },
  }
  const environment = new ClientEnvironment(world)
  environment.init({ baseEnvironment: base })
  environment.buildCSM()
  return { environment, scene: world.stage.scene }
}

const skyNode = (name, more) => ({
  _bg: `asset://${name}-bg.png`,
  _hdr: `asset://${name}-sky.hdr`,
  _sunIntensity: 7,
  _sunColor: '#ff0000',
  _fogNear: 1,
  _fogFar: 50,
  _fogColor: '#00ff00',
  _rotationY: 0.5,
  ...more,
})

test('a sky whose background or HDR fails still applies its sun, fog and rotation; the failure is reported once', async t => {
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(String(line)))
  const textures = new Map()
  const { environment, scene } = makeEnvironment(async (type, url) => {
    if (url.includes('missing')) throw new Error('asset request failed: HTTP 404')
    if (!textures.has(url)) textures.set(url, type === 'hdr' ? new THREE.DataTexture() : new THREE.Texture())
    return textures.get(url)
  })
  environment.addSky(skyNode('missing'))
  await tick()
  const light = environment.csm.lights[0]
  assert.equal(light.intensity, 7)
  assert.equal(light.color.getHexString(), 'ff0000')
  assert.equal(scene.fog.near, 1)
  assert.equal(scene.fog.far, 50)
  assert.equal(scene.fog.color.getHexString(), '00ff00')
  assert.equal(environment.sky.rotation.y, 0.5)
  assert.equal(environment.sky.visible, false, 'no background: as when none is set')
  assert.equal(scene.environment, null, 'no HDR: as when none is set')
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every(line => line.startsWith('[environment]') && line.includes('HTTP 404')))
  // the same sky again (a shadows preference change rebuilds it) does not report again
  await environment.updateSky()
  assert.equal(warnings.length, 2)
  // a background that fails next to an HDR that loads: the HDR applies
  environment.addSky(skyNode('mixed', { _bg: 'asset://missing-2.png' }))
  await tick()
  assert.equal(scene.environment, textures.get('asset://mixed-sky.hdr'))
  assert.equal(environment.sky.visible, false)
  assert.equal(warnings.length, 3)
})

test('a newer sky wins over an older one whose assets finish loading later', async () => {
  const gates = []
  const { environment, scene } = makeEnvironment(
    (type, url) =>
      new Promise(resolve => {
        const texture = type === 'hdr' ? new THREE.DataTexture() : new THREE.Texture()
        texture.name = url
        if (url.includes('slow')) gates.push(() => resolve(texture))
        else resolve(texture)
      })
  )
  const older = environment.addSky(skyNode('slow', { _sunIntensity: 2 }))
  environment.addSky(skyNode('fast', { _sunIntensity: 3 }))
  await tick()
  assert.equal(environment.csm.lights[0].intensity, 3)
  assert.equal(environment.sky.material.map.name, 'asset://fast-bg.png')
  gates.forEach(release => release())
  await tick()
  assert.equal(environment.csm.lights[0].intensity, 3, 'the older load that finished late does not apply')
  assert.equal(environment.sky.material.map.name, 'asset://fast-bg.png')
  assert.equal(scene.environment.name, 'asset://fast-sky.hdr')
  assert.ok(older)
})
