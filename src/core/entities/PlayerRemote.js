import * as THREE from '../extras/three'
import { Entity } from './Entity'
import { createNode } from '../extras/createNode'
import { outranks, isAdmin, isBuilder, isMuted } from '../extras/playerRanks'
import { createPlayerAura, chatBubble } from '../extras/playerAura'
import { BufferedLerpVector3 } from '../extras/BufferedLerpVector3'
import { BufferedLerpQuaternion } from '../extras/BufferedLerpQuaternion'

let capsuleGeometry
{
  const radius = 0.3
  const inner = 1.2
  const height = radius + inner + radius
  capsuleGeometry = new THREE.CapsuleGeometry(radius, inner) // matches PlayerLocal capsule size
  capsuleGeometry.translate(0, height / 2, 0)
}

export class PlayerRemote extends Entity {
  constructor(world, data, local) {
    super(world, data, local)
    this.isPlayer = true
    this.isRemote = true
    this.init()
  }

  async init() {
    this.base = createNode('group')
    this.base.position.fromArray(this.data.position)
    this.base.quaternion.fromArray(this.data.quaternion)

    this.body = createNode('rigidbody', { type: 'kinematic' })
    this.body.active = this.data.effect?.anchorId ? false : true
    this.base.add(this.body)
    this.collider = createNode('collider', {
      type: 'geometry',
      convex: true,
      geometry: capsuleGeometry,
      layer: 'player',
    })
    this.body.add(this.collider)

    // this.caps = createNode('mesh', {
    //   type: 'geometry',
    //   geometry: capsuleGeometry,
    //   material: new THREE.MeshStandardMaterial({ color: 'white' }),
    // })
    // this.base.add(this.caps)

    const auraNodes = createPlayerAura({ label: this.data.name, health: this.data.health })
    this.aura = auraNodes.aura
    this.nametag = auraNodes.nametag
    this.bubble = auraNodes.bubble
    this.bubbleBox = auraNodes.bubbleBox
    this.bubbleText = auraNodes.bubbleText

    this.aura.activate({ world: this.world, entity: this })
    this.base.activate({ world: this.world, entity: this })

    this.applyAvatar()

    this.position = new BufferedLerpVector3(this.base.position, this.world.networkRate * 1.5)
    this.quaternion = new BufferedLerpQuaternion(this.base.quaternion, this.world.networkRate * 1.5)
    this.teleport = 0

    this.mode = 0
    this.axis = new THREE.Vector3()
    this.gaze = new THREE.Vector3()

    this.world.setHot(this, true)
  }

  applyAvatar() {
    const avatarUrl = this.data.sessionAvatar || this.data.avatar || 'asset://avatar.vrm'
    if (this.avatarUrl === avatarUrl) return
    this.world.loader.load('avatar', avatarUrl).then(src => {
      if (this.avatar) this.avatar.deactivate()
      this.avatar = src.toNodes().get('avatar')
      this.base.add(this.avatar)
      this.nametag.position.y = this.avatar.getHeadToHeight() + 0.2
      this.bubble.position.y = this.avatar.getHeadToHeight() + 0.2
      if (!this.bubble.active) {
        this.nametag.active = true
      }
      this.avatarUrl = avatarUrl
    })
  }

  getAnchorMatrix() {
    if (this.data.effect?.anchorId) {
      return this.world.anchors.get(this.data.effect.anchorId)
    }
  }

  outranks(otherPlayer) {
    return outranks(this, otherPlayer)
  }

  isAdmin() {
    return isAdmin(this)
  }

  isBuilder() {
    return isBuilder(this)
  }

  isMuted() {
    return isMuted(this)
  }

  update(delta) {
    const anchor = this.getAnchorMatrix()
    if (!anchor) {
      this.position.update(delta)
      this.quaternion.update(delta)
    }
    this.avatar?.setEmote(this.data.emote)
    this.avatar?.instance?.setLocomotion(this.mode, this.axis, this.gaze)
  }

  lateUpdate(delta) {
    const anchor = this.getAnchorMatrix()
    if (anchor) {
      this.position.snap()
      this.quaternion.snap()
      this.base.position.setFromMatrixPosition(anchor)
      this.base.quaternion.setFromRotationMatrix(anchor)
      this.base.clean()
    }
    if (this.avatar) {
      const matrix = this.avatar.getBoneTransform('head')
      if (matrix) {
        this.aura.position.setFromMatrixPosition(matrix)
      }
    }
  }

  setEffect(effect, onEnd) {
    if (this.data.effect) {
      this.data.effect = null
      this.onEffectEnd?.()
      this.onEffectEnd = null
    }
    this.data.effect = effect
    this.onEffectEnd = onEnd
    this.body.active = effect?.anchorId ? false : true
  }

  setSpeaking(speaking) {
    if (this.speaking === speaking) return
    if (speaking && this.isMuted()) return
    this.speaking = speaking
    const name = this.data.name
    this.nametag.label = speaking ? `» ${name} «` : name
  }

  modify(data) {
    let avatarChanged
    if (Object.prototype.hasOwnProperty.call(data, 't')) {
      this.teleport++
    }
    if (Object.prototype.hasOwnProperty.call(data, 'p')) {
      this.data.position = data.p
      this.position.push(data.p, this.teleport)
    }
    if (Object.prototype.hasOwnProperty.call(data, 'q')) {
      this.data.quaternion = data.q
      this.quaternion.push(data.q, this.teleport)
    }
    if (Object.prototype.hasOwnProperty.call(data, 'm')) {
      this.data.mode = data.m
      this.mode = data.m
    }
    if (Object.prototype.hasOwnProperty.call(data, 'a')) {
      this.data.axis = data.a
      this.axis.fromArray(data.a)
    }
    if (Object.prototype.hasOwnProperty.call(data, 'g')) {
      this.data.gaze = data.g
      this.gaze.fromArray(data.g)
    }
    if (Object.prototype.hasOwnProperty.call(data, 'e')) {
      this.data.emote = data.e
    }
    if (Object.prototype.hasOwnProperty.call(data, 'ef')) {
      this.setEffect(data.ef)
    }
    if (Object.prototype.hasOwnProperty.call(data, 'name')) {
      this.data.name = data.name
      this.nametag.label = data.name
      this.world.emit('name', { playerId: this.data.id, name: this.data.name })
    }
    if (Object.prototype.hasOwnProperty.call(data, 'health')) {
      this.data.health = data.health
      this.nametag.health = data.health
      this.world.events.emit('health', { playerId: this.data.id, health: data.health })
    }
    if (Object.prototype.hasOwnProperty.call(data, 'avatar')) {
      this.data.avatar = data.avatar
      avatarChanged = true
    }
    if (Object.prototype.hasOwnProperty.call(data, 'sessionAvatar')) {
      this.data.sessionAvatar = data.sessionAvatar
      avatarChanged = true
    }
    if (Object.prototype.hasOwnProperty.call(data, 'rank')) {
      this.data.rank = data.rank
      this.world.emit('rank', { playerId: this.data.id, rank: this.data.rank })
    }
    if (avatarChanged) {
      this.applyAvatar()
    }
  }

  chat(msg) {
    chatBubble(this, msg)
  }

  destroy(local) {
    if (this.destroyed) return
    this.destroyed = true

    clearTimeout(this.chatTimer)
    this.base.deactivate()
    this.avatar = null
    this.world.setHot(this, false)
    this.world.events.emit('leave', { playerId: this.data.id })
    this.aura.deactivate()
    this.aura = null

    this.world.entities.remove(this.data.id)
    // if removed locally we need to broadcast to server/clients
    if (local) {
      this.world.network.send('entityRemoved', this.data.id)
    }
  }
}
