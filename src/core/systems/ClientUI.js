import { isBoolean } from 'lodash-es'
import { ControlPriorities } from '../extras/ControlPriorities'
import { System } from './System'

const appPanes = ['app', 'script', 'nodes', 'meta']

export class ClientUI extends System {
  constructor(world) {
    super(world)
    this.state = {
      visible: true,
      active: false,
      app: null,
      pane: null,
      reticleSuppressors: 0,
    }
    this.lastAppPane = 'app'
    this.links = 0
    this.control = null
    // The last value of each world event the interface learns only by being told: the local player is in (`ready`,
    // told once), the connection was refused (`kick`) or closed (`disconnect`), a confirm dialog or the avatar pane
    // waits for an answer. The interface is made again after a render error (ErrorBoundary.js, mode root) and starts
    // from these: one that started from nothing would wait for a `ready` that never comes again, behind the loading
    // screen, and a confirm dialog would never be answered. `link` is the question askOpen() put (below).
    this.latest = { ready: false, kick: null, disconnect: false, confirm: null, avatar: null, link: null }
    this.remember = {}
    for (const name in this.latest) {
      this.remember[name] = value => {
        this.latest[name] = value
      }
      world.on(name, this.remember[name])
    }
    // a question nobody can see or answer is taken back: in an immersive session this interface is not shown
    this.onXRSession = session => {
      if (session) this.latest.link?.cancel()
    }
    world.on('xrSession', this.onXRSession)
  }

  start() {
    this.control = this.world.controls.bind({ priority: ControlPriorities.CORE_UI })
  }

  update() {
    if (this.control.escape.pressed) {
      if (this.latest.link) {
        this.latest.link.cancel()
      } else if (this.state.pane) {
        this.state.pane = null
        this.broadcast()
      } else if (this.state.app) {
        this.state.app = null
        this.broadcast()
      }
    }
    if (
      this.control.keyZ.pressed &&
      !this.control.metaLeft.down &&
      !this.control.controlLeft.down &&
      !this.control.shiftLeft.down
    ) {
      this.state.visible = !this.state.visible
      this.broadcast()
      this.dropHiddenLink()
    }
    if (this.control.pointer.locked && this.state.active) {
      this.state.active = false
      this.broadcast()
    }
    if (!this.control.pointer.locked && !this.state.active) {
      this.state.active = true
      this.broadcast()
    }
  }

  togglePane(pane) {
    if (pane === null || this.state.pane === pane) {
      this.state.pane = null
    } else {
      // if (appPanes.includes(this.state.pane) && !appPanes.includes(pane)) {
      //   this.state.app = null
      // }
      this.state.pane = pane
      if (appPanes.includes(pane)) {
        this.lastAppPane = pane
      }
    }
    this.broadcast()
  }

  toggleVisible(value) {
    value = isBoolean(value) ? value : !this.state.visible
    if (this.state.visible === value) return
    this.state.visible = value
    this.broadcast()
    this.dropHiddenLink()
  }

  setApp(app) {
    this.state.app = app
    this.state.pane = app ? this.lastAppPane : null
    this.broadcast()
  }

  suppressReticle() {
    this.state.reticleSuppressors++
    let released
    this.broadcast()
    return () => {
      if (released) return
      this.state.reticleSuppressors--
      this.broadcast()
      released = true
    }
  }

  confirm(options) {
    const promise = new Promise(resolve => {
      options.confirm = () => {
        this.world.emit('confirm', null)
        resolve(true)
      }
      options.cancel = () => {
        this.world.emit('confirm', null)
        resolve(false)
      }
    })
    this.world.emit('confirm', options)
    return promise
  }

  // A script asked to open a page outside this world's origin (Apps.js, world.open): the visitor is asked, and
  // `go` runs from their click on Open, or never. Returns true when the question was put, and otherwise the reason
  // it was not, as text.
  // - One question at a time. A request made while one is on screen is dropped: not queued (a script could line up
  //   any number) and not shown in its place (the address under the visitor's pointer would change).
  // - Nothing is asked in an immersive session, where this interface is not visible, and a question that waits
  //   when one starts, or when the interface is hidden (Z), is cancelled. An interface that is hidden when the
  //   question comes is shown.
  // What this does not do: judge the page, stop a script from asking again after a Cancel, or stop it from drawing
  // its own text in the world around the question.
  askOpen({ href, host, shown, newTab, go }) {
    if (this.latest.link) return 'another link is waiting for the visitor'
    if (this.world.xr?.session) return 'links are not offered in an immersive session'
    let answered = false
    const close = () => {
      if (answered) return false
      answered = true
      if (this.latest.link === link) this.world.emit('link', null)
      return true
    }
    const link = {
      id: ++this.links,
      href,
      host,
      shown,
      newTab,
      open: () => {
        if (!close()) return
        // asked before the session began, answered in it by something other than the visitor's press
        if (this.world.xr?.session) return
        go()
      },
      cancel: () => {
        close()
      },
    }
    this.world.emit('link', link)
    if (!this.state.visible) this.toggleVisible(true)
    // the buttons cannot be reached with the pointer held by the world
    this.world.controls?.unlockPointer?.()
    return true
  }

  dropHiddenLink() {
    if (!this.state.visible) this.latest.link?.cancel()
  }

  broadcast() {
    this.world.emit('ui', { ...this.state })
  }

  destroy() {
    this.control?.release()
    this.control = null
    for (const name in this.remember) this.world.off(name, this.remember[name])
    this.world.off('xrSession', this.onXRSession)
  }
}
