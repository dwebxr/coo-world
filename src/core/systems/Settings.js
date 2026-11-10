import { isBoolean } from 'lodash-es'
import { System } from './System'
import { Ranks } from '../extras/ranks'
import { normalizeSettingValue } from '../extras/settingsPolicy'
import { createLogOnce } from '../extras/logOnce'

const KEYS = ['title', 'desc', 'image', 'avatar', 'customAvatars', 'voice', 'rank', 'playerLimit', 'ao']
// what a stored or received value that fails the settings rules is replaced with (the rows are not changed)
const FALLBACKS = {
  title: null,
  desc: null,
  image: null,
  avatar: null,
  customAvatars: false,
  voice: 'spatial',
  rank: Ranks.VISITOR,
  playerLimit: 0,
  ao: true,
}
const logFallback = createLogOnce(message => console.warn(message))

export class Settings extends System {
  constructor(world) {
    super(world)

    this.title = null
    this.desc = null
    this.image = null
    this.avatar = null
    this.customAvatars = null
    this.voice = null
    this.rank = null
    this.playerLimit = null
    this.ao = null

    this.changes = null
  }

  setHasAdminCode(value) {
    this.hasAdminCode = value
  }

  get effectiveRank() {
    return this.hasAdminCode ? this.rank : Ranks.ADMIN
  }

  // Persisted settings (on the server) and the join snapshot (on a client) go through the rules a settingsModified
  // packet does; a value that fails them is replaced with that key's fallback, said once per key. A missing key
  // stays unset, as before.
  deserialize(data) {
    for (const key of KEYS) {
      const value = data?.[key]
      if (value === undefined) {
        this[key] = undefined
        continue
      }
      const result = normalizeSettingValue(key, value)
      if (result.ok) {
        this[key] = result.value
      } else {
        this[key] = FALLBACKS[key]
        logFallback(this, key, `[settings] stored ${key} is not valid; using ${JSON.stringify(FALLBACKS[key])}`)
      }
    }
    this.emit('change', {
      title: { value: this.title },
      desc: { value: this.desc },
      image: { value: this.image },
      avatar: { value: this.avatar },
      customAvatars: { value: this.customAvatars },
      voice: { value: this.voice },
      rank: { value: this.rank },
      playerLimit: { value: this.playerLimit },
      ao: { value: this.ao },
    })
  }

  serialize() {
    return {
      desc: this.desc,
      title: this.title,
      image: this.image,
      avatar: this.avatar,
      customAvatars: this.customAvatars,
      voice: this.voice,
      rank: this.rank,
      playerLimit: this.playerLimit,
      ao: this.ao,
    }
  }

  preFixedUpdate() {
    if (!this.changes) return
    this.emit('change', this.changes)
    this.changes = null
  }

  modify(key, value) {
    if (this[key] === value) return
    const prev = this[key]
    this[key] = value
    if (!this.changes) this.changes = {}
    if (!this.changes[key]) this.changes[key] = { prev, value: null }
    this.changes[key].value = value
  }

  set(key, value, broadcast) {
    if (this.world.network.isClient) {
      const result = normalizeSettingValue(key, value)
      if (!result.ok) return false
      value = result.value
    }
    this.modify(key, value)
    if (broadcast) {
      this.world.network.send('settingsModified', { key, value })
    }
  }
}
