export class Entity {
  constructor(world, data, local) {
    this.world = world
    this.data = data

    // if spawned locally we need to broadcast to server/clients
    if (local) {
      this.world.network.send('entityAdded', data)
    }
  }

  modify(_data) {
    // called when remote receives entity changes
    // or applying local changes
  }

  onEvent(_version, _name, _data, _networkId) {
    // ...
  }

  serialize() {
    return this.data
  }

  destroy(_local) {
    // ...
  }
}
