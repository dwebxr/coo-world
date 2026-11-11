import { System } from './System'

import { Matrix3, Vector3 as StockVector3 } from 'three'
import * as THREE from '../extras/three'
import { DEG2RAD, RAD2DEG } from '../extras/general'
import { clamp, num, uuid } from '../utils'
import { LerpVector3 } from '../extras/LerpVector3'
import { LerpQuaternion } from '../extras/LerpQuaternion'
import { Curve, Keyframe } from '../extras/Curve'
import { prng } from '../extras/prng'
import { BufferedLerpVector3 } from '../extras/BufferedLerpVector3'
import { BufferedLerpQuaternion } from '../extras/BufferedLerpQuaternion'
import { createScriptCompartment, wrapRawCode } from '../extras/scriptCompartment'
import { hardenForScripts, hardenScriptClasses } from '../extras/scriptHardening'
import { createScriptObjectURL, revokeScriptObjectURL } from '../extras/scriptBlob'
import { createScriptConsole, hostInspect } from '../extras/scriptConsole'

/**
 * Script System
 *
 * - Runs on both the server and client.
 * - Executes scripts inside secure compartments
 * - One compartment per script asset, with locked endowments
 *
 */

// Classes scripts can reach. The first group is endowed to every script (createEndowments). The second is not,
// but its instances are reachable: THREE's own Vector3 is what the Lerp classes and the math classes' internal
// temporaries are made of, Matrix3 is accepted and produced by Matrix4 methods, a Curve holds Keyframes, and a
// material proxy returns its Color.
// THREE's Object3D is deliberately not offered to scripts: it dispatches shared, mutable event objects, through
// which a script listener could get hold of every object the engine later adds to its scene.
const SCRIPT_CLASSES = [
  ['Vector3', THREE.Vector3],
  ['Quaternion', THREE.Quaternion],
  ['Euler', THREE.Euler],
  ['Matrix4', THREE.Matrix4],
  ['LerpVector3', LerpVector3],
  ['LerpQuaternion', LerpQuaternion],
  ['BufferedLerpVector3', BufferedLerpVector3],
  ['BufferedLerpQuaternion', BufferedLerpQuaternion],
  ['Curve', Curve],
  ['StockVector3', StockVector3],
  ['Matrix3', Matrix3],
  ['Keyframe', Keyframe],
  ['Color', THREE.Color],
]

function hardenClasses() {
  // THREE's constructors create their type flag on the prototype (`X.prototype.isX = true`) the first time
  // they run; it has to exist before the prototype is frozen
  new StockVector3()
  new Matrix3()
  new THREE.Matrix4()
  hardenScriptClasses(SCRIPT_CLASSES)
}

export class Scripts extends System {
  constructor(world) {
    super(world)
    hardenClasses()
    // shared host functions are frozen once, so no script can stash data on them
    this.helpers = hardenForScripts({ num, prng, clamp, uuid })
    // on Node, script console arguments are rendered to strings before they reach the host console
    this.inspect = hostInspect()
  }

  // fresh wrapper objects per compartment: no object is shared between two scripts
  createEndowments() {
    return {
      console: hardenForScripts(createScriptConsole({ inspect: this.inspect })),
      Date: hardenForScripts({
        now: () => Date.now(),
      }),
      URL: hardenForScripts({
        createObjectURL: blob => createScriptObjectURL(blob),
        revokeObjectURL: url => revokeScriptObjectURL(url),
      }),
      Math,
      eval: undefined,
      harden: undefined,
      lockdown: undefined,
      num: this.helpers.num,
      prng: this.helpers.prng,
      clamp: this.helpers.clamp,
      // Layers,
      Quaternion: THREE.Quaternion,
      Vector3: THREE.Vector3,
      Euler: THREE.Euler,
      Matrix4: THREE.Matrix4,
      LerpVector3, // deprecated - use BufferedLerpVector3
      LerpQuaternion, // deprecated - use BufferedLerpQuaternion
      BufferedLerpVector3,
      BufferedLerpQuaternion,
      // Material: Material,
      Curve,
      // Gradient: Gradient,
      DEG2RAD,
      RAD2DEG,
      uuid: this.helpers.uuid,
      // pause: () => this.world.pause(),
    }
  }

  evaluate(code) {
    const compartment = createScriptCompartment(this.createEndowments())
    let value
    const result = {
      exec: (...args) => {
        if (!value) value = compartment.evaluate(wrapRawCode(code))
        return value(...args)
      },
      code,
    }
    return result
  }
}
