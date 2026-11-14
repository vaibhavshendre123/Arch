import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MAX_NODES, assertArchitecture } from '../src/models/architecture.schema.js'
import { ApiError } from '../src/middleware/errorHandler.js'

const node = (id, overrides = {}) => ({
  id,
  type: 'server',
  name: `Node ${id}`,
  parameters: {},
  ...overrides,
})
const edge = (id, source, target, overrides = {}) => ({ id, source, target, ...overrides })

function rejects(arch, pattern) {
  assert.throws(() => assertArchitecture(arch, ApiError), (err) => {
    assert.equal(err.statusCode, 400)
    assert.match(err.message, pattern)
    return true
  })
}

describe('architecture validation — shape', () => {
  it('accepts a well-formed architecture and keeps its parameters', () => {
    const result = assertArchitecture(
      {
        nodes: [node('a', { parameters: { capacity: 200, processingTime: 12 } }), node('b', { type: 'database' })],
        edges: [edge('e1', 'a', 'b')],
      },
      ApiError,
    )
    assert.equal(result.nodes.length, 2)
    assert.deepEqual(result.nodes[0].parameters, { capacity: 200, processingTime: 12 })
  })

  it('rejects an unknown component type', () => {
    rejects({ nodes: [node('a', { type: 'quantum' })], edges: [] }, /unknown type/)
  })

  it('rejects a component with no name', () => {
    rejects({ nodes: [node('a', { name: '   ' })], edges: [] }, /needs a name/)
  })

  it('rejects duplicate component ids', () => {
    rejects({ nodes: [node('a'), node('a')], edges: [] }, /Duplicate component id/)
  })

  it('rejects a self connection', () => {
    rejects({ nodes: [node('a')], edges: [edge('e1', 'a', 'a')] }, /cannot point at itself/)
  })

  it('rejects a connection to a component that does not exist', () => {
    rejects({ nodes: [node('a')], edges: [edge('e1', 'a', 'ghost')] }, /does not exist/)
  })

  it('rejects two connections with the same direction', () => {
    rejects(
      { nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b'), edge('e2', 'a', 'b')] },
      /Duplicate connection/,
    )
  })

  it('rejects a connection with no id', () => {
    rejects({ nodes: [node('a'), node('b')], edges: [{ source: 'a', target: 'b' }] }, /needs an id/)
  })

  it('rejects more components than the limit', () => {
    const nodes = Array.from({ length: MAX_NODES + 1 }, (_, i) => node(`n${i}`))
    rejects({ nodes, edges: [] }, /at most/)
  })
})

describe('architecture validation — parameters', () => {
  it('rejects a parameter the UI never exposes', () => {
    rejects(
      { nodes: [node('a', { parameters: { sneaky: 1 } })], edges: [] },
      /Unknown parameter "sneaky"/,
    )
  })

  it('rejects a non-numeric parameter value', () => {
    rejects(
      { nodes: [node('a', { parameters: { capacity: '200' } })], edges: [] },
      /must be a finite number/,
    )
  })

  it('rejects a parameter that is NaN or Infinity', () => {
    rejects({ nodes: [node('a', { parameters: { capacity: Number.NaN } })], edges: [] }, /finite number/)
    rejects(
      { nodes: [node('a', { parameters: { capacity: Number.POSITIVE_INFINITY } })], edges: [] },
      /finite number/,
    )
  })

  it('rejects capacity at zero and below', () => {
    rejects({ nodes: [node('a', { parameters: { capacity: 0 } })], edges: [] }, /greater than 1/)
    rejects({ nodes: [node('a', { parameters: { capacity: -5 } })], edges: [] }, /greater than 1/)
  })

  it('rejects a negative processing time', () => {
    rejects({ nodes: [node('a', { parameters: { processingTime: -1 } })], edges: [] }, /at least 0/)
  })

  it('rejects a probability outside 0..1', () => {
    rejects(
      { nodes: [node('a', { parameters: { failureProbability: 1.5 } })], edges: [] },
      /at most 1/,
    )
  })

  it('rejects a retry limit that is not a whole number', () => {
    rejects({ nodes: [node('a', { parameters: { retryLimit: 1.5 } })], edges: [] }, /whole number/)
  })

  it('rejects a value above the UI maximum', () => {
    rejects({ nodes: [node('a', { parameters: { processingTime: 501 } })], edges: [] }, /at most 500/)
  })
})
