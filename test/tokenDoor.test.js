import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Vector3, Euler } from 'three'
import 'ses'
await import('../src/core/lockdown.js')

const fixture = fs.readFileSync(new URL('./e2e/apps/token-door.js', import.meta.url), 'utf8')
const gate = fixture.slice(fixture.indexOf('app.configure('))

function door(type) {
  const nodes = new Map()
  const updates = []
  const node = id => {
    const value = { position: new Vector3(0.1, 2, 3), rotation: new Euler(0, 0.2, 0), add() {} }
    nodes.set(id, value)
    return value
  }
  node('Frame')
  const left = node('LeftDoor')
  const right = node('RightDoor')
  let balance = 12345.678
  const app = {
    config: { type, minimumAmount: 10000, slideDistance: '1', maxRotation: '45', direction: '1' },
    configure() {},
    get: id => nodes.get(id),
    create: (type, props) => Object.assign(node(props.id), props),
    add() {},
    on: (name, callback) => {
      if (name === 'update') updates.push(callback)
    },
  }
  const world = {
    isClient: true,
    on() {},
    getPlayer: () => ({ getTokenBalance: async () => ({ verified: true, known: true, balance }) }),
  }
  new Compartment({ app, world }).evaluate(gate)
  return {
    trigger: () => nodes.get('token-door-open').onTrigger(),
    update: dt => updates.forEach(fn => fn(dt)),
    label: () => nodes.get('token-door-balance').value,
    setBalance: value => {
      balance = value
    },
    transforms: () => [
      left.position.toArray(),
      right.position.toArray(),
      left.rotation.toArray(),
      right.rotation.toArray(),
    ],
  }
}

test('door: SES balance formatting groups, rounds and expands exponents', async () => {
  for (const [balance, expected] of [
    [0, '0'],
    [0.004, '0'],
    [0.005, '0.01'],
    [1.005, '1.01'],
    [999.999, '1,000'],
    [1234.5, '1,234.5'],
    [1e-7, '0'],
    [1e21, '1,000,000,000,000,000,000,000'],
    [1.23456e25, '12,345,600,000,000,000,000,000,000'],
  ]) {
    const d = door('1')
    d.setBalance(balance)
    await d.trigger()
    assert.equal(d.label(), `Your Balance: ${expected} COO`)
  }
})

for (const type of ['1', '2']) {
  test(`door: type ${type} repeated Open stays open and restarts the close timer`, async () => {
    const d = door(type)
    const closed = d.transforms()
    await d.trigger()
    assert.equal(d.label(), 'Your Balance: 12,345.68 COO')
    d.update(0.5)
    const opened = d.transforms()
    assert.notDeepEqual(opened, closed)
    d.update(2)
    d.setBalance(1e21)
    await d.trigger()
    assert.equal(d.label(), 'Your Balance: 1,000,000,000,000,000,000,000 COO')
    d.update(2)
    assert.deepEqual(d.transforms(), opened, 'stays open beyond the original closing deadline')
    d.update(0.5)
    assert.deepEqual(d.transforms(), opened)
    d.update(0.5)
    assert.deepEqual(d.transforms(), closed, 'auto-close restores authored transforms')
  })
}
