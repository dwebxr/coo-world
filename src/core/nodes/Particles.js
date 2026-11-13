import * as THREE from '../extras/three'
import { every, isArray } from 'lodash-es'
import { isBoolean, isNumber, isPrimitive, isString } from '../extras/scriptPrimitives.js'
import { boundedInteger, boundedNumber, boundedText, FLOAT32_MAX } from '../extras/boundedValue.js'

import { Node } from './Node'
import { scriptView, sealMath } from '../extras/sealMath.js'

// a vector the node owns: a script's values read once into a sealed engine vector, by the engine's number rule (the
// vector's constructor applies it, engineNumber.js; null stays null)
function ownVector(value) {
  if (!value) return null
  return sealMath(new THREE.Vector3(value.x, value.y, value.z))
}

const shapeTypes = ['point', 'sphere', 'hemisphere', 'cone', 'box', 'circle', 'rectangle']
const spaces = ['local', 'world']
const blendings = ['additive', 'normal']
const billboards = ['full', 'y', 'direction']

// shape types
// -------------
// ['point']
// ['sphere', radius, thickness]
// ['hemisphere', radius, thickness]
// ['cone', radius, thickness, angle]
// ['box', width, height, depth, thickness, origin(volume|edge), spherize(bool)]
// ['circle', radius, thickness, spherize]
// ['rectangle', width, depth, thickness, spherize]

// start format
// ------------
// fixed: 1
// linear: 1-3
// random: 1~3

// lifetime format
// ---------------
// multipliers applied over particle lifetime –
// `${time},${value}|${time},${value}` etc
// time = ratio from start of life to end (0 to 1)
// value = size, rotate, color, alpha, emissive etc
// eg: `0,1|0.5,2|1,1`

// What a particles node keeps of its sizes (boundedValue.js): the pool and its buffers are `max` long (the client makes
// seventeen floats a particle, twice, and the worker one object each), and `rate` and a burst's `count` are how many
// the worker tries to start in one step.
export const PARTICLES_MAX = 20000
export const PARTICLES_MAX_RATE = 100000 // a second
export const PARTICLES_MAX_BURSTS = 64
export const PARTICLES_MIN_DURATION = 0.01 // seconds
export const PARTICLES_MAX_TIME = 1e6 // seconds
export const PARTICLES_MAX_TIMESCALE = 100
// The texts the worker parses: a start value (`1~5`, `red-blue`) and an over-life curve, of which the worker reads 64
// points. A point of two numbers as JavaScript prints them is at most 52 characters (`-0.0000012512313393425237`
// twice, a comma and a bar), so 64 of them fit; what is past the limit is cut.
export const PARTICLES_MAX_START_LENGTH = 256
export const PARTICLES_MAX_CURVE_LENGTH = 4096
// `direction` and `velocityRadial`, which the worker multiplies by, are kept within the largest float32 (the most its
// Float32Array buffers hold), so an Infinity there becomes this number; as Infinity it gave the worker 0 * Infinity
// and Infinity / Infinity, which are NaN. This does not keep the worker free of NaN in general (a timescale of 0 with a
// radial velocity still gives it). A direction of this size randomizes completely: the shape's own direction is lost in
// the rounding.
export const PARTICLES_MAX_FACTOR = FLOAT32_MAX

// prettier-ignore
const defaults = {
  // emitter
  emitting: true,
  shape: ['cone', 1, 1, 25],
  direction: 0,                       // 0 = no direction randomization, 1 = completely randomize direction
  rate: 10,                           // number of particles emitted per second
  bursts: [],                         // bursts of particles at specific times – { time: 0, count: 10 }
  duration: 5,                        // how long particles emit for (null forever)
  loop: true,                         // start again after duration ends
  max: 1000,                          // maximum number of particles before oldest start being used
  timescale: 1,                       // override to increase/decrease emitter time scale
  
  // initial values (see start format)
  life: '5',                          // particle lifetime
  speed: '1',                         // particle start speed
  size: '1',                          // particle start size
  rotate: '0',                        // particle start rotation (degrees)
  color: 'white',                     // particle start color
  alpha: '1',                         // particle start alpha
  emissive: '1',                      // particle start emissive intensity (bloom)

  // rendering
  image: '/particle.png',
  spritesheet: null,                  // [rows, cols, frameRate, loops]
  blending: 'normal',                 // additive or normal (normal requires sorting)
  lit: false,                         // lit or unlit material
  billboard: 'full',
  space: 'world',                     // world or local space

  // simulation
  force: null,                        // vector3 for gravity, levitation, wind etc
  velocityLinear: null,               // [x,y,z]
  velocityOrbital: null,              // [x,y,z]
  velocityRadial: null,               // number

  rateOverDistance: 0,
  sizeOverLife: null,                 // see lifetime format above for this and the following...
  rotateOverLife: null,
  colorOverLife: null,            
  alphaOverLife: null, 
  emissiveOverLife: null,

  onEnd: null,
}

export class Particles extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'particles'

    this.emitting = data.emitting
    this.shape = data.shape
    this.direction = data.direction
    this.rate = data.rate
    this.bursts = data.bursts
    this.duration = data.duration
    this.loop = data.loop
    this.max = data.max
    this.timescale = data.timescale

    this.life = data.life
    this.speed = data.speed
    this.size = data.size
    this.rotate = data.rotate
    this.color = data.color
    this.alpha = data.alpha
    this.emissive = data.emissive

    this.image = data.image
    this.spritesheet = data.spritesheet
    this.blending = data.blending
    this.lit = data.lit
    this.billboard = data.billboard
    this.space = data.space

    this.force = data.force
    this.velocityLinear = data.velocityLinear
    this.velocityOrbital = data.velocityOrbital
    this.velocityRadial = data.velocityRadial

    this.rateOverDistance = data.rateOverDistance
    this.sizeOverLife = data.sizeOverLife
    this.rotateOverLife = data.rotateOverLife
    this.colorOverLife = data.colorOverLife
    this.alphaOverLife = data.alphaOverLife
    this.emissiveOverLife = data.emissiveOverLife

    this.onEnd = data.onEnd
  }

  mount() {
    this.needsRebuild = false
    this.emitter = this.ctx.world.particles?.register(this)
  }

  commit(didMove) {
    if (this.needsRebuild) {
      this.remount()
      return
    }
    if (didMove) {
      // emitter tracks matrixWorld automatically
    }
  }

  unmount() {
    this.emitter?.destroy()
    this.emitter = null
  }

  copy(source, recursive) {
    super.copy(source, recursive)

    this._emitting = source._emitting
    this._shape = Object.freeze([...source._shape])
    this._direction = source._direction
    this._rate = source._rate
    this._bursts = Object.freeze(source._bursts.map(burst => Object.freeze({ ...burst })))
    this._duration = source._duration
    this._loop = source._loop
    this._max = source._max
    this._timescale = source._timescale

    this._life = source._life
    this._speed = source._speed
    this._size = source._size
    this._rotate = source._rotate
    this._color = source._color
    this._alpha = source._alpha
    this._emissive = source._emissive

    this._image = source._image
    this._spritesheet = source._spritesheet
    this._blending = source._blending
    this._lit = source._lit
    this._billboard = source._billboard
    this._space = source._space

    this._force = ownVector(source._force)
    this._velocityLinear = ownVector(source._velocityLinear)
    this._velocityOrbital = ownVector(source._velocityOrbital)
    this._velocityRadial = source._velocityRadial

    this._rateOverDistance = source._rateOverDistance
    this._sizeOverLife = source._sizeOverLife
    this._rotateOverLife = source._rotateOverLife
    this._colorOverLife = source._colorOverLife
    this._alphaOverLife = source._alphaOverLife
    this._emissiveOverLife = source._emissiveOverLife

    this._onEnd = source._onEnd

    return this
  }

  getConfig() {
    const config = {
      emitting: this._emitting,
      shape: this._shape,
      direction: this._direction,
      rate: this._rate,
      bursts: this._bursts,
      duration: this._duration,
      loop: this._loop,
      max: this._max,
      timescale: this._timescale,

      life: this._life,
      speed: this._speed,
      size: this._size,
      rotate: this._rotate,
      color: this._color,
      alpha: this._alpha,
      emissive: this._emissive,

      image: this._image,
      spritesheet: this._spritesheet,
      blending: this._blending,
      lit: this._lit,
      billboard: this._billboard,
      space: this._space,

      force: this._force?.toArray() || null,
      velocityLinear: this._velocityLinear?.toArray() || null,
      velocityOrbital: this._velocityOrbital?.toArray() || null,
      velocityRadial: this._velocityRadial,

      rateOverDistance: this._rateOverDistance,
      sizeOverLife: this._sizeOverLife,
      rotateOverLife: this._rotateOverLife,
      colorOverLife: this._colorOverLife,
      alphaOverLife: this._alphaOverLife,
      emissiveOverLife: this._emissiveOverLife,
    }
    return config
  }

  get emitting() {
    return this._emitting
  }

  set emitting(value = defaults.emitting) {
    if (!isBoolean(value)) {
      throw new Error('[particles] emitting not a boolean')
    }
    if (this._emitting === value) return
    this._emitting = value
    this.emitter?.setEmitting(value)
  }

  get shape() {
    return this._shape
  }

  // shape, bursts and the spritesheet are kept as the node's own frozen copies of plain values (the defaults were one
  // array shared by every particles node of every app; the emitter's config is cloned into a worker, which would read
  // a getter, or fail on a function, in the middle of a mount); each value is read once, then checked
  set shape(value = defaults.shape) {
    const shape = isArray(value) ? Object.freeze(Array.from(value)) : value
    if (!isShape(shape)) {
      throw new Error('[particles] shape invalid')
    }
    this._shape = shape
    this.needsRebuild = true
    this.setDirty()
  }

  get direction() {
    return this._direction
  }

  set direction(value = defaults.direction) {
    if (!isNumber(value)) {
      throw new Error('[particles] direction not a number')
    }
    this._direction = boundedNumber(value, defaults.direction, -PARTICLES_MAX_FACTOR, PARTICLES_MAX_FACTOR)
    this.needsRebuild = true
    this.setDirty()
  }

  get rate() {
    return this._rate
  }

  set rate(value = defaults.rate) {
    if (!isNumber(value)) {
      throw new Error('[particles] rate not a number')
    }
    this._rate = boundedNumber(value, defaults.rate, 0, PARTICLES_MAX_RATE)
    this.needsRebuild = true
    this.setDirty()
  }

  get bursts() {
    return this._bursts
  }

  set bursts(value = defaults.bursts) {
    // the first PARTICLES_MAX_BURSTS entries are read (each field once), checked, then bounded
    let bursts = value
    if (isArray(value)) {
      bursts = []
      const count = Math.min(value.length, PARTICLES_MAX_BURSTS)
      for (let i = 0; i < count; i++) {
        const item = value[i]
        bursts.push({ time: item?.time, count: item?.count })
      }
    }
    if (!isBursts(bursts)) {
      throw new Error('[particles] bursts invalid')
    }
    for (const burst of bursts) {
      burst.time = boundedNumber(burst.time, 0, 0, PARTICLES_MAX_TIME)
      burst.count = boundedInteger(burst.count, 0, 0, PARTICLES_MAX)
      Object.freeze(burst)
    }
    this._bursts = Object.freeze(bursts)
    this.needsRebuild = true
    this.setDirty()
  }

  get duration() {
    return this._duration
  }

  set duration(value = defaults.duration) {
    if (!isNumber(value)) {
      throw new Error('[particles] duration not a number')
    }
    // not zero: the cycle's progress is the time over the duration, and a cycle that is over at once starts its
    // bursts again in every step
    this._duration = boundedNumber(value, defaults.duration, PARTICLES_MIN_DURATION, PARTICLES_MAX_TIME)
    this.needsRebuild = true
    this.setDirty()
  }

  get loop() {
    return this._loop
  }

  set loop(value = defaults.loop) {
    if (!isBoolean(value)) {
      throw new Error('[particles] loop not a boolean')
    }
    this._loop = value
    this.needsRebuild = true
    this.setDirty()
  }

  get max() {
    return this._max
  }

  set max(value = defaults.max) {
    if (!isNumber(value)) {
      throw new Error('[particles] max not a number')
    }
    this._max = boundedInteger(value, defaults.max, 0, PARTICLES_MAX)
    this.needsRebuild = true
    this.setDirty()
  }

  get timescale() {
    return this._timescale
  }

  set timescale(value = defaults.timescale) {
    if (!isNumber(value)) {
      throw new Error('[particles] timescale not a number')
    }
    this._timescale = boundedNumber(value, defaults.timescale, 0, PARTICLES_MAX_TIMESCALE)
    this.needsRebuild = true
    this.setDirty()
  }

  get life() {
    return this._life
  }

  set life(value = defaults.life) {
    if (!isStartNumeric(value)) {
      throw new Error('[particles] life invalid')
    }
    this._life = boundedText(value, PARTICLES_MAX_START_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get speed() {
    return this._speed
  }

  set speed(value = defaults.speed) {
    if (!isStartNumeric(value)) {
      throw new Error('[particles] speed invalid')
    }
    this._speed = boundedText(value, PARTICLES_MAX_START_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get size() {
    return this._size
  }

  set size(value = defaults.size) {
    if (!isStartNumeric(value)) {
      throw new Error('[particles] size invalid')
    }
    this._size = boundedText(value, PARTICLES_MAX_START_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get rotate() {
    return this._rotate
  }

  set rotate(value = defaults.rotate) {
    if (!isStartNumeric(value)) {
      throw new Error('[particles] rotate invalid')
    }
    this._rotate = boundedText(value, PARTICLES_MAX_START_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get color() {
    return this._color
  }

  set color(value = defaults.color) {
    if (!isStartColor(value)) {
      throw new Error('[particles] color invalid')
    }
    this._color = boundedText(value, PARTICLES_MAX_START_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get alpha() {
    return this._alpha
  }

  set alpha(value = defaults.alpha) {
    if (!isStartNumeric(value)) {
      throw new Error('[particles] alpha invalid')
    }
    this._alpha = boundedText(value, PARTICLES_MAX_START_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get emissive() {
    return this._emissive
  }

  set emissive(value = defaults.emissive) {
    if (!isStartNumeric(value)) {
      throw new Error('[particles] emissive invalid')
    }
    this._emissive = boundedText(value, PARTICLES_MAX_START_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get image() {
    return this._image
  }

  set image(value = defaults.image) {
    if (!isString(value)) {
      throw new Error('[particles] image not a string')
    }
    this._image = value
    this.needsRebuild = true
    this.setDirty()
  }

  get spritesheet() {
    return this._spritesheet
  }

  set spritesheet(value = defaults.spritesheet) {
    const spritesheet = isArray(value) ? Object.freeze(Array.from(value)) : value
    if (spritesheet !== null && !isSpritesheet(spritesheet)) {
      throw new Error('[particles] spritesheet invalid')
    }
    this._spritesheet = spritesheet
    this.needsRebuild = true
    this.setDirty()
  }

  get blending() {
    return this._blending
  }

  set blending(value = defaults.blending) {
    if (!isBlending(value)) {
      throw new Error('[particles] blending invalid')
    }
    this._blending = value
    this.needsRebuild = true
    this.setDirty()
  }

  get lit() {
    return this._lit
  }

  set lit(value = defaults.lit) {
    if (!isBoolean(value)) {
      throw new Error('[particles] lit not a boolean')
    }
    this._lit = value
    this.needsRebuild = true
    this.setDirty()
  }

  get billboard() {
    return this._billboard
  }

  set billboard(value = defaults.billboard) {
    if (!isBillboard(value)) {
      throw new Error('[particles] billboard invalid')
    }
    this._billboard = value
    this.needsRebuild = true
    this.setDirty()
  }

  get space() {
    return this._space
  }

  set space(value = defaults.space) {
    if (value !== null && !isSpace(value)) {
      throw new Error('[particles] space invalid')
    }
    this._space = value
    this.needsRebuild = true
    this.setDirty()
  }

  get force() {
    return this._force
  }

  set force(value = defaults.force) {
    if (value !== null && !value.isVector3) {
      throw new Error('[particles] force not a Vector3')
    }
    // the engine keeps its own copy of the values (read now, once), not the script's vector
    this._force = ownVector(value)
    this.needsRebuild = true
    this.setDirty()
  }

  get velocityLinear() {
    return this._velocityLinear
  }

  set velocityLinear(value = defaults.velocityLinear) {
    if (value !== null && !value.isVector3) {
      throw new Error('[particles] velocityLinear not a Vector3')
    }
    this._velocityLinear = ownVector(value)
    this.needsRebuild = true
    this.setDirty()
  }

  get velocityOrbital() {
    return this._velocityOrbital
  }

  set velocityOrbital(value = defaults.velocityOrbital) {
    if (value !== null && !value.isVector3) {
      throw new Error('[particles] velocityOrbital not a Vector3')
    }
    this._velocityOrbital = ownVector(value)
    this.needsRebuild = true
    this.setDirty()
  }

  get velocityRadial() {
    return this._velocityRadial
  }

  set velocityRadial(value = defaults.velocityRadial) {
    if (value !== null && !isNumber(value)) {
      throw new Error('[particles] velocityRadial not a number')
    }
    this._velocityRadial =
      value === null ? null : boundedNumber(value, defaults.velocityRadial, -PARTICLES_MAX_FACTOR, PARTICLES_MAX_FACTOR)
    this.needsRebuild = true
    this.setDirty()
  }

  get rateOverDistance() {
    return this._rateOverDistance
  }

  set rateOverDistance(value = defaults.rateOverDistance) {
    if (!Number.isFinite(value) || value < 0) return
    this._rateOverDistance = value
    this.needsRebuild = true
    this.setDirty()
  }

  get sizeOverLife() {
    return this._sizeOverLife
  }

  set sizeOverLife(value = defaults.sizeOverLife) {
    if (value !== null && !isString(value)) {
      throw new Error('[particles] sizeOverLife invalid')
    }
    this._sizeOverLife = value === null ? null : boundedText(value, PARTICLES_MAX_CURVE_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get rotateOverLife() {
    return this._rotateOverLife
  }

  set rotateOverLife(value = defaults.rotateOverLife) {
    if (value !== null && !isString(value)) {
      throw new Error('[particles] rotateOverLife invalid')
    }
    this._rotateOverLife = value === null ? null : boundedText(value, PARTICLES_MAX_CURVE_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get colorOverLife() {
    return this._colorOverLife
  }

  set colorOverLife(value = defaults.colorOverLife) {
    if (value !== null && !isString(value)) {
      throw new Error('[particles] colorOverLife invalid')
    }
    this._colorOverLife = value === null ? null : boundedText(value, PARTICLES_MAX_CURVE_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get alphaOverLife() {
    return this._alphaOverLife
  }

  set alphaOverLife(value = defaults.alphaOverLife) {
    if (value !== null && !isString(value)) {
      throw new Error('[particles] alphaOverLife invalid')
    }
    this._alphaOverLife = value === null ? null : boundedText(value, PARTICLES_MAX_CURVE_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get emissiveOverLife() {
    return this._emissiveOverLife
  }

  set emissiveOverLife(value = defaults.emissiveOverLife) {
    if (value !== null && !isString(value)) {
      throw new Error('[particles] emissiveOverLife invalid')
    }
    this._emissiveOverLife = value === null ? null : boundedText(value, PARTICLES_MAX_CURVE_LENGTH)
    this.needsRebuild = true
    this.setDirty()
  }

  get onEnd() {
    return this._onEnd
  }

  set onEnd(value = defaults.onEnd) {
    this._onEnd = value
    this.needsRebuild = true
    this.setDirty()
  }

  getProxy() {
    const self = this
    if (!this.proxy) {
      let proxy = {
        get emitting() {
          return self.emitting
        },
        set emitting(value) {
          self.emitting = value
        },
        get shape() {
          return self.shape
        },
        set shape(value) {
          self.shape = value
        },
        get direction() {
          return self.direction
        },
        set direction(value) {
          self.direction = value
        },
        get rate() {
          return self.rate
        },
        set rate(value) {
          self.rate = value
        },
        get bursts() {
          return self.bursts
        },
        set bursts(value) {
          self.bursts = value
        },
        get duration() {
          return self.duration
        },
        set duration(value) {
          self.duration = value
        },
        get loop() {
          return self.loop
        },
        set loop(value) {
          self.loop = value
        },
        get max() {
          return self.max
        },
        set max(value) {
          self.max = value
        },
        get timescale() {
          return self.timescale
        },
        set timescale(value) {
          self.timescale = value
        },
        get life() {
          return self.life
        },
        set life(value) {
          self.life = value
        },
        get speed() {
          return self.speed
        },
        set speed(value) {
          self.speed = value
        },
        get size() {
          return self.size
        },
        set size(value) {
          self.size = value
        },
        get rotate() {
          return self.rotate
        },
        set rotate(value) {
          self.rotate = value
        },
        get color() {
          return self.color
        },
        set color(value) {
          self.color = value
        },
        get alpha() {
          return self.alpha
        },
        set alpha(value) {
          self.alpha = value
        },
        get emissive() {
          return self.emissive
        },
        set emissive(value) {
          self.emissive = value
        },
        get image() {
          return self.image
        },
        set image(value) {
          self.image = value
        },
        get spritesheet() {
          return self.spritesheet
        },
        set spritesheet(value) {
          self.spritesheet = value
        },
        get blending() {
          return self.blending
        },
        set blending(value) {
          self.blending = value
        },
        get lit() {
          return self.lit
        },
        set lit(value) {
          self.lit = value
        },
        get billboard() {
          return self.billboard
        },
        set billboard(value) {
          self.billboard = value
        },
        get space() {
          return self.space
        },
        set space(value) {
          self.space = value
        },
        get force() {
          return scriptView(self.force)
        },
        set force(value) {
          self.force = value
        },
        get velocityLinear() {
          return scriptView(self.velocityLinear)
        },
        set velocityLinear(value) {
          self.velocityLinear = value
        },
        get velocityOrbital() {
          return scriptView(self.velocityOrbital)
        },
        set velocityOrbital(value) {
          self.velocityOrbital = value
        },
        get velocityRadial() {
          return self.velocityRadial
        },
        set velocityRadial(value) {
          self.velocityRadial = value
        },
        get rateOverDistance() {
          return self.rateOverDistance
        },
        set rateOverDistance(value) {
          self.rateOverDistance = value
        },
        get sizeOverLife() {
          return self.sizeOverLife
        },
        set sizeOverLife(value) {
          self.sizeOverLife = value
        },
        get rotateOverLife() {
          return self.rotateOverLife
        },
        set rotateOverLife(value) {
          self.rotateOverLife = value
        },
        get colorOverLife() {
          return self.colorOverLife
        },
        set colorOverLife(value) {
          self.colorOverLife = value
        },
        get alphaOverLife() {
          return self.alphaOverLife
        },
        set alphaOverLife(value) {
          self.alphaOverLife = value
        },
        get emissiveOverLife() {
          return self.emissiveOverLife
        },
        set emissiveOverLife(value) {
          self.emissiveOverLife = value
        },
        get onEnd() {
          return self.onEnd
        },
        set onEnd(value) {
          self.onEnd = value
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy())) // inherit Node properties
      this.proxy = proxy
    }
    return this.proxy
  }
}

function isShape(value) {
  return isArray(value) && shapeTypes.includes(value[0]) && value.every(isPrimitive)
}

function isBursts(value) {
  return isArray(value) && every(value, item => isNumber(item.time) && isNumber(item.count))
}

function isStartNumeric(value) {
  return isString(value)
}

function isStartColor(value) {
  return isString(value)
}

function isSpritesheet(value) {
  return isArray(value) && value.length === 4 && value.every(isPrimitive)
}

function isBlending(value) {
  return blendings.includes(value)
}

function isSpace(value) {
  return spaces.includes(value)
}

function isBillboard(value) {
  return billboards.includes(value)
}
