import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// The browser's localStorage, with a fallback. A browser can refuse it altogether (site data blocked, some
// private modes: every access throws a SecurityError) or refuse a write (quota). The client used to fail to
// start in the first case, because prefs and the session token are read while the world is constructed. A value
// that cannot be read or written is kept in memory for this page instead, so the session works and simply
// does not persist.
export class LocalStorage {
  // `backend`: returns the Storage to use (read on each call: reading the global can itself throw)
  constructor(backend = () => globalThis.localStorage) {
    this.backend = backend
    this.memory = new Map()
    this.warned = false
  }

  unavailable(err) {
    if (this.warned) return
    this.warned = true
    console.warn(`storage: localStorage is not available (${err?.name || 'error'}); settings last for this page only`)
  }

  get(key, defaultValue = null) {
    if (this.memory.has(key)) return this.memory.get(key)
    let data
    try {
      data = this.backend().getItem(key)
    } catch (err) {
      this.unavailable(err)
      return defaultValue
    }
    if (data === null || data === undefined) return defaultValue
    let value
    try {
      value = JSON.parse(data)
    } catch (err) {
      console.error('error reading storage key:', key)
      return defaultValue
    }
    // a stored false or 0 is a value (it used to come back as the default)
    return value ?? defaultValue
  }

  set(key, value) {
    if (value === undefined || value === null) return this.remove(key)
    try {
      this.backend().setItem(key, JSON.stringify(value))
      this.memory.delete(key)
    } catch (err) {
      this.unavailable(err)
      this.memory.set(key, value)
    }
  }

  remove(key) {
    this.memory.delete(key)
    try {
      this.backend().removeItem(key)
    } catch (err) {
      this.unavailable(err)
    }
  }
}

class NodeStorage {
  constructor() {
    const dirname = path.dirname(fileURLToPath(import.meta.url))
    const rootDir = path.join(dirname, '../')
    this.file = path.join(rootDir, 'localstorage.json')
    try {
      const data = fs.readFileSync(this.file, 'utf8')
      this.data = JSON.parse(data)
    } catch (err) {
      this.data = {}
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch (err) {
      console.error('error writing to storage file:', err)
    }
  }

  get(key, defaultValue = null) {
    const value = this.data[key]
    return value ?? defaultValue
  }

  set(key, value) {
    if (value === undefined || value === null) {
      delete this.data[key]
    } else {
      this.data[key] = value
    }
    this.save()
  }

  remove(key) {
    delete this.data[key]
    this.save()
  }
}

const isBrowser = typeof window !== 'undefined'
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node

let storage

if (isBrowser) {
  storage = new LocalStorage()
} else if (isNode) {
  storage = new NodeStorage()
} else {
  console.warn('no storage')
}

export { storage }
