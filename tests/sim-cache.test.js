import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SIM_CACHE_LIMIT, initialState, reducer } from '../src/store/reducer.js'

const keys = (state) => Object.keys(state.simCache)

function put(state, key) {
  return reducer(state, { type: 'CACHE_RESULT', key, value: { key } })
}

function fill(count, start = 0) {
  let state = initialState
  for (let i = start; i < start + count; i += 1) state = put(state, `k${i}`)
  return state
}

describe('simCache is bounded', () => {
  it('never holds more than the limit, however many runs complete', () => {
    const state = fill(SIM_CACHE_LIMIT + 10)
    assert.equal(keys(state).length, SIM_CACHE_LIMIT)
  })

  it('evicts the oldest key first', () => {
    const state = fill(SIM_CACHE_LIMIT + 2)
    const kept = keys(state)

    assert.equal(kept.includes('k0'), false, 'the first result must be the one evicted')
    assert.equal(kept.includes('k1'), false)
    assert.equal(kept.includes(`k${SIM_CACHE_LIMIT + 1}`), true, 'the newest result must survive')
  })

  it('keeps the most recently written entry when a key is overwritten', () => {
    let state = fill(SIM_CACHE_LIMIT)
    // Recompute the oldest entry: it is now the most recently used, so the *next* new key
    // should evict k1 rather than k0.
    state = put(state, 'k0')
    state = put(state, 'brand-new')

    const kept = keys(state)
    assert.equal(kept.includes('k0'), true, 'a refreshed key must not be the next eviction')
    assert.equal(kept.includes('k1'), false, 'the genuinely oldest key is evicted')
  })

  it('stores each key independently', () => {
    let state = put(initialState, 'a')
    state = put(state, 'b')
    assert.deepEqual(state.simCache.a, { key: 'a' })
    assert.deepEqual(state.simCache.b, { key: 'b' })
  })

  it('CLEAR_CACHE empties it completely', () => {
    const state = reducer(fill(3), { type: 'CLEAR_CACHE' })
    assert.deepEqual(state.simCache, {})
  })
})
