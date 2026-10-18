// Event names raised by the engine itself: app hooks (App.js) and world events.
// Scripts may not emit or send them, and the server never dispatches them from the network.
export const internalEvents = [
  'fixedUpdate',
  'update',
  'updated',
  'animate',
  'lateUpdate',
  'destroy',
  'enter',
  'leave',
  'wallet',
  'chat',
  'command',
  'health',
]
