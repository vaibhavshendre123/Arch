import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { nodeTypes, parameterMeta } from '../src/data/nodeTypes.js'
import { NODE_TYPE_KEYS, PARAMETER_SPEC } from '../backend/src/models/parameter-spec.js'

/**
 * The backend mirrors the frontend's parameter and node-type vocabulary because it is
 * deployed as its own package and cannot import from the frontend tree. This test is what
 * stops the two copies drifting: adding a parameter to `parameterMeta` without adding it
 * to the server spec would make a legitimate save fail with "Unknown parameter", and
 * adding a node type without the server list would make it unsaveable.
 */
describe('backend contract mirrors the frontend vocabulary', () => {
  it('knows exactly the node types the palette offers', () => {
    assert.deepEqual([...NODE_TYPE_KEYS].sort(), Object.keys(nodeTypes).sort())
  })

  it('accepts exactly the parameters the UI exposes', () => {
    assert.deepEqual(Object.keys(PARAMETER_SPEC).sort(), Object.keys(parameterMeta).sort())
  })

  it('uses the same upper bounds as the UI inputs', () => {
    for (const [key, meta] of Object.entries(parameterMeta)) {
      assert.equal(
        PARAMETER_SPEC[key].max,
        meta.max,
        `server maximum for "${key}" drifted from parameterMeta`,
      )
    }
  })
})
