import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Ranks, isRank, hasRank } from '../src/core/extras/ranks.js'

test('isRank: true when ranks match', () => {
  assert.equal(isRank(Ranks.ADMIN, Ranks.ADMIN), true)
})

test('isRank: false when ranks differ', () => {
  assert.equal(isRank(Ranks.VISITOR, Ranks.ADMIN), false)
})

test('hasRank: true when player rank is above the minimum', () => {
  assert.equal(hasRank(Ranks.ADMIN, Ranks.BUILDER), true)
})

test('hasRank: true when player rank equals the minimum', () => {
  assert.equal(hasRank(Ranks.BUILDER, Ranks.BUILDER), true)
})

test('hasRank: false when player rank is below the minimum', () => {
  assert.equal(hasRank(Ranks.VISITOR, Ranks.BUILDER), false)
})
