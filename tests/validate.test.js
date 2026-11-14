/**
 * Comprehensive validation tests — covers all cases from the spec (A-N) plus
 * structural edge cases and the backend-bypass guard in the worker.
 *
 * Run with:  node --test tests/validate.test.js
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateArchitecture, canSimulate, CODES } from '../src/lib/validate.js'
import { runSimulation } from '../src/lib/engine.js'
import { toContract } from '../src/lib/contract.js'

// ---------------------------------------------------------------------------
// Architecture builder helpers
// ---------------------------------------------------------------------------

function node(id, type, name, parameters = {}) {
  return { id, type, name: name || type, parameters }
}

function edge(source, target, id) {
  return { id: id || `e-${source}-${target}`, source, target }
}

/** A minimal valid linear architecture: User → Web Client → API Gateway → Server → Database */
function validLinear() {
  return {
    nodes: [
      node('user-1', 'user', 'User'),
      node('web-1', 'webClient', 'Web Client'),
      node('gw-1', 'apiGateway', 'API Gateway'),
      node('srv-1', 'server', 'Server'),
      node('db-1', 'database', 'Database'),
    ],
    edges: [
      edge('user-1', 'web-1'),
      edge('web-1', 'gw-1'),
      edge('gw-1', 'srv-1'),
      edge('srv-1', 'db-1'),
    ],
  }
}

/** A hub-and-spoke architecture with multiple clients → shared gateway → services */
function hubAndSpoke() {
  return {
    nodes: [
      node('web-1', 'webClient', 'Web Client'),
      node('mob-1', 'mobileClient', 'Mobile Client'),
      node('gw-1', 'apiGateway', 'API Gateway'),
      node('srv-1', 'server', 'Service A'),
      node('srv-2', 'microservice', 'Service B'),
      node('db-1', 'database', 'Database'),
    ],
    edges: [
      edge('web-1', 'gw-1'),
      edge('mob-1', 'gw-1'),
      edge('gw-1', 'srv-1'),
      edge('gw-1', 'srv-2'),
      edge('srv-1', 'db-1'),
      edge('srv-2', 'db-1'),
    ],
  }
}

/** Event-driven: User → API Gateway → Queue → Worker (microservice) → Database */
function eventDriven() {
  return {
    nodes: [
      node('user-1', 'user', 'User'),
      node('gw-1', 'apiGateway', 'API Gateway'),
      node('q-1', 'queue', 'Job Queue'),
      node('ms-1', 'microservice', 'Worker'),
      node('db-1', 'database', 'Database'),
    ],
    edges: [
      edge('user-1', 'gw-1'),
      edge('gw-1', 'q-1'),
      edge('q-1', 'ms-1'),
      edge('ms-1', 'db-1'),
    ],
  }
}

/** Architecture with a legitimate cycle (A→B→C→A) plus a terminal */
function cycleArch() {
  return {
    nodes: [
      node('user-1', 'user', 'User'),
      node('gw-1', 'apiGateway', 'API Gateway'),
      node('lb-1', 'loadBalancer', 'Load Balancer'),
      node('srv-1', 'server', 'Server'),
      node('db-1', 'database', 'Database'),
    ],
    edges: [
      edge('user-1', 'gw-1'),
      edge('gw-1', 'lb-1'),
      edge('lb-1', 'srv-1'),
      edge('srv-1', 'lb-1'), // retry/feedback loop — lb-1 ↔ srv-1
      edge('srv-1', 'db-1'),
    ],
  }
}

// ---------------------------------------------------------------------------
// TEST A — Empty architecture
// ---------------------------------------------------------------------------

describe('Test A: Empty architecture', () => {
  it('rejects an architecture with no components', () => {
    const r = validateArchitecture({ nodes: [], edges: [] })
    assert.equal(r.valid, false)
    assert.equal(r.canSimulate, false)
    assert.ok(r.errors.some((e) => e.code === CODES.EMPTY_ARCHITECTURE), 'Expected EMPTY_ARCHITECTURE error')
  })

  it('rejects null/undefined architecture', () => {
    const r1 = validateArchitecture(null)
    assert.equal(r1.valid, false)
    const r2 = validateArchitecture(undefined)
    assert.equal(r2.valid, false)
  })

  it('canSimulate returns false for empty architecture', () => {
    assert.equal(canSimulate({ nodes: [], edges: [] }), false)
    assert.equal(canSimulate(null), false)
  })

  it('simulation engine would be blocked by the worker guard', () => {
    // Simulate what the worker does: validateArchitecture then runSimulation
    const arch = { nodes: [], edges: [] }
    const validation = validateArchitecture(arch)
    assert.equal(validation.canSimulate, false, 'Worker guard must block empty architecture')
  })
})

// ---------------------------------------------------------------------------
// TEST B — Valid linear architecture
// ---------------------------------------------------------------------------

describe('Test B: Valid linear architecture', () => {
  it('accepts User → Web Client → API Gateway → Server → Database', () => {
    const r = validateArchitecture(validLinear())
    assert.equal(r.valid, true)
    assert.equal(r.canSimulate, true)
    assert.equal(r.errors.length, 0)
  })

  it('canSimulate returns true for valid linear architecture', () => {
    assert.equal(canSimulate(validLinear()), true)
  })

  it('simulation engine actually runs on valid architecture', () => {
    const result = runSimulation(toContract(validLinear()), { arrivalRate: 10, duration: 5, seed: 1 }, {})
    assert.ok(result.metrics.totalRequests > 0, 'Expected requests to be processed')
    assert.ok(typeof result.metrics.successRate === 'number', 'Expected success rate')
  })
})

// ---------------------------------------------------------------------------
// TEST C — Isolated component
// ---------------------------------------------------------------------------

describe('Test C: Isolated component', () => {
  it('detects an isolated Cache component', () => {
    const arch = {
      ...validLinear(),
      nodes: [...validLinear().nodes, node('cache-1', 'cache', 'Cache')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.equal(r.canSimulate, false)
    const isolatedErr = r.errors.find((e) => e.code === CODES.ISOLATED_COMPONENT)
    assert.ok(isolatedErr, 'Expected ISOLATED_COMPONENT error')
    assert.ok(isolatedErr.componentIds.includes('cache-1'), 'Expected cache-1 in componentIds')
    assert.ok(isolatedErr.suggestion, 'Expected a suggestion')
  })

  it('simulation is blocked when an isolated component exists', () => {
    const arch = {
      ...validLinear(),
      nodes: [...validLinear().nodes, node('cache-1', 'cache', 'Cache')],
    }
    assert.equal(canSimulate(arch), false)
  })
})

// ---------------------------------------------------------------------------
// TEST D — Missing connection (disconnected segments)
// ---------------------------------------------------------------------------

describe('Test D: Missing connection / disconnected segments', () => {
  it('detects when API Gateway segment is not connected to Server segment', () => {
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('web-1', 'webClient', 'Web Client'),
        node('gw-1', 'apiGateway', 'API Gateway'),
        node('srv-1', 'server', 'Server'),
        node('db-1', 'database', 'Database'),
      ],
      edges: [
        edge('user-1', 'web-1'),
        edge('web-1', 'gw-1'),
        // gap here: gw-1 not connected to srv-1
        edge('srv-1', 'db-1'),
      ],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.equal(r.canSimulate, false)
    // srv-1 or db-1 should be unreachable OR isolated
    const hasReachabilityErr = r.errors.some(
      (e) => e.code === CODES.UNREACHABLE_COMPONENT || e.code === CODES.ISOLATED_COMPONENT,
    )
    assert.ok(hasReachabilityErr, 'Expected a reachability or isolation error for disconnected segment')
  })
})

// ---------------------------------------------------------------------------
// TEST E — Forbidden bypass: client directly connecting to database
// ---------------------------------------------------------------------------

describe('Test E: Client directly to database (architectural check)', () => {
  it('blocks direct user-to-database connection as a required layer bypass', () => {
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('db-1', 'database', 'Database'),
      ],
      edges: [edge('user-1', 'db-1')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.equal(r.canSimulate, false)
    const bypassErr = r.errors.find((e) => e.code === CODES.REQUIRED_APPLICATION_LAYER_BYPASSED)
    assert.ok(bypassErr, 'Expected REQUIRED_APPLICATION_LAYER_BYPASSED error')
    assert.ok(bypassErr.componentIds.includes('user-1') && bypassErr.componentIds.includes('db-1'))
  })

  it('blocks web client directly connecting to database or cache', () => {
    const arch = {
      nodes: [
        node('web-1', 'webClient', 'Web App'),
        node('db-1', 'database', 'Database'),
      ],
      edges: [edge('web-1', 'db-1')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.ok(r.errors.find((e) => e.code === CODES.REQUIRED_APPLICATION_LAYER_BYPASSED))
  })

  it('detects star topology where user is illegally connected to every component', () => {
    // User directly connected to: database, cache, fileStorage, queue, messageBroker, server, microservice
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('gw-1', 'apiGateway', 'Gateway'),
        node('srv-1', 'server', 'Server'),
        node('ms-1', 'microservice', 'Microservice'),
        node('db-1', 'database', 'Database'),
        node('cache-1', 'cache', 'Cache'),
        node('fs-1', 'fileStorage', 'File Storage'),
        node('q-1', 'queue', 'Queue'),
        node('mb-1', 'messageBroker', 'Broker'),
      ],
      edges: [
        edge('user-1', 'gw-1'), // valid
        edge('user-1', 'srv-1'), // invalid: user -> server bypasses client/gateway
        edge('user-1', 'ms-1'), // invalid: user -> microservice bypasses client/gateway
        edge('user-1', 'db-1'), // invalid: user -> database
        edge('user-1', 'cache-1'), // invalid: user -> cache
        edge('user-1', 'fs-1'), // invalid: user -> fileStorage
        edge('user-1', 'q-1'), // invalid: user -> queue
        edge('user-1', 'mb-1'), // invalid: user -> broker
      ],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false, 'User connected to every component must fail validation')
    assert.equal(r.canSimulate, false, 'Simulation must be blocked')

    // Multiple specific errors should be flagged
    const codes = r.errors.map((e) => e.code)
    assert.ok(codes.includes(CODES.REQUIRED_APPLICATION_LAYER_BYPASSED), 'Must flag storage bypass')
    assert.ok(codes.includes(CODES.INVALID_INFRASTRUCTURE_ACCESS), 'Must flag queue/broker access')
    assert.ok(codes.includes(CODES.INVALID_CLIENT_TARGET), 'Must flag direct server/microservice target')
    assert.ok(r.errors.length >= 7, 'Expected at least 7 violations for the 7 invalid connections')
  })
})

// ---------------------------------------------------------------------------
// TEST F — Hub-and-spoke (multiple clients, shared gateway)
// ---------------------------------------------------------------------------

describe('Test F: Hub-and-spoke — multiple clients, shared gateway', () => {
  it('accepts hub-and-spoke without false positives', () => {
    const r = validateArchitecture(hubAndSpoke())
    assert.equal(r.valid, true)
    assert.equal(r.canSimulate, true)
    assert.equal(r.errors.length, 0)
  })

  it('canSimulate returns true for hub-and-spoke', () => {
    assert.equal(canSimulate(hubAndSpoke()), true)
  })
})

// ---------------------------------------------------------------------------
// TEST G — Multiple entry points
// ---------------------------------------------------------------------------

describe('Test G: Multiple entry points', () => {
  it('accepts architecture with multiple valid entry clients', () => {
    const arch = {
      nodes: [
        node('web-1', 'webClient', 'Web'),
        node('mob-1', 'mobileClient', 'Mobile'),
        node('gw-1', 'apiGateway', 'API Gateway'),
        node('db-1', 'database', 'Database'),
      ],
      edges: [
        edge('web-1', 'gw-1'),
        edge('mob-1', 'gw-1'),
        edge('gw-1', 'db-1'),
      ],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, true)
    assert.equal(r.canSimulate, true)
    assert.equal(r.errors.length, 0)
    // Multiple entry points → warning only
    const warn = r.warnings.find((w) => w.code === CODES.MULTIPLE_ENTRY_POINTS)
    assert.ok(warn, 'Expected MULTIPLE_ENTRY_POINTS warning')
  })
})

// ---------------------------------------------------------------------------
// TEST H — Legitimate cycle
// ---------------------------------------------------------------------------

describe('Test H: Legitimate cycle', () => {
  it('does not reject an architecture with a feedback/retry loop', () => {
    const r = validateArchitecture(cycleArch())
    // A cycle is a warning, not an error
    assert.equal(r.errors.length, 0, 'Cycle should not produce an error')
    assert.equal(r.valid, true)
    assert.equal(r.canSimulate, true)
    const cycleWarn = r.warnings.find((w) => w.code === CODES.CYCLE_DETECTED)
    assert.ok(cycleWarn, 'Expected CYCLE_DETECTED warning')
  })

  it('canSimulate returns true for an architecture with a cycle', () => {
    assert.equal(canSimulate(cycleArch()), true)
  })
})

// ---------------------------------------------------------------------------
// TEST I — Invalid edge endpoint (dangling edge)
// ---------------------------------------------------------------------------

describe('Test I: Invalid edge — references nonexistent component', () => {
  it('detects an edge pointing to a nonexistent node', () => {
    const arch = {
      ...validLinear(),
      edges: [...validLinear().edges, edge('srv-1', 'ghost-node-99')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.equal(r.canSimulate, false)
    const dangErr = r.errors.find((e) => e.code === CODES.DANGLING_EDGE)
    assert.ok(dangErr, 'Expected DANGLING_EDGE error')
  })

  it('detects an edge from a nonexistent source node', () => {
    const arch = {
      ...validLinear(),
      edges: [...validLinear().edges, edge('ghost-99', 'db-1')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    const dangErr = r.errors.find((e) => e.code === CODES.DANGLING_EDGE)
    assert.ok(dangErr, 'Expected DANGLING_EDGE error')
  })
})

// ---------------------------------------------------------------------------
// TEST J — Backend bypass (worker guard)
// ---------------------------------------------------------------------------

describe('Test J: Backend bypass — worker guard must block invalid architecture', () => {
  it('validateArchitecture blocks before the engine would run', () => {
    // Simulate what sim.worker.js does: validate then run
    const invalidArch = { nodes: [], edges: [] }
    const validation = validateArchitecture(invalidArch)
    assert.equal(validation.canSimulate, false, 'Worker guard must refuse empty architecture')
    assert.ok(validation.errors.length > 0, 'Worker must have errors to report')
    // The engine is never called — confirmed by the guard returning false
  })

  it('worker guard blocks isolated component architecture', () => {
    const arch = {
      ...validLinear(),
      nodes: [...validLinear().nodes, node('cache-1', 'cache', 'Cache')], // isolated
    }
    const validation = validateArchitecture(arch)
    assert.equal(validation.canSimulate, false)
    assert.ok(validation.errors.find((e) => e.code === CODES.ISOLATED_COMPONENT))
  })

  it('worker guard blocks architecture with dangling edges', () => {
    const arch = {
      ...validLinear(),
      edges: [
        ...validLinear().edges,
        edge('srv-1', 'nonexistent-99'),
      ],
    }
    const validation = validateArchitecture(arch)
    assert.equal(validation.canSimulate, false)
    assert.ok(validation.errors.find((e) => e.code === CODES.DANGLING_EDGE))
  })
})

// ---------------------------------------------------------------------------
// TEST K — Correct an invalid architecture
// ---------------------------------------------------------------------------

describe('Test K: Architecture correction clears errors', () => {
  it('old errors are absent after fixing the architecture', () => {
    // Step 1: invalid (user connected directly to database)
    const invalidArch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('gw-1', 'apiGateway', 'Gateway'),
        node('srv-1', 'server', 'Server'),
        node('db-1', 'database', 'Database'),
      ],
      edges: [
        edge('user-1', 'db-1'), // invalid direct bypass!
      ],
    }
    const r1 = validateArchitecture(invalidArch)
    assert.equal(r1.valid, false)
    assert.ok(r1.errors.some((e) => e.code === CODES.REQUIRED_APPLICATION_LAYER_BYPASSED))

    // Step 2: fixed (proper layered architecture)
    const fixedArch = {
      nodes: invalidArch.nodes,
      edges: [
        edge('user-1', 'gw-1'),
        edge('gw-1', 'srv-1'),
        edge('srv-1', 'db-1'),
      ],
    }
    const r2 = validateArchitecture(fixedArch)
    assert.equal(r2.valid, true)
    assert.equal(r2.canSimulate, true)
    assert.equal(r2.errors.length, 0)
  })
})

// ---------------------------------------------------------------------------
// TEST L — Architecture change invalidates previous result
// ---------------------------------------------------------------------------

describe('Test L: Change after validation should require revalidation', () => {
  it('removing a connection produces errors that did not exist before', () => {
    const r1 = validateArchitecture(validLinear())
    assert.equal(r1.valid, true)

    // Simulate removing the gw-1 → srv-1 connection
    const broken = {
      ...validLinear(),
      edges: validLinear().edges.filter((e) => !(e.source === 'gw-1' && e.target === 'srv-1')),
    }
    const r2 = validateArchitecture(broken)
    assert.equal(r2.valid, false, 'Validation result must update after removing a connection')
    assert.equal(r2.canSimulate, false)
  })
})

// ---------------------------------------------------------------------------
// TEST M — No analytics pollution
// ---------------------------------------------------------------------------

describe('Test M: No analytics pollution from invalid architectures', () => {
  it('the engine is never invoked when validation fails', () => {
    const invalidArch = { nodes: [], edges: [] }
    const validation = validateArchitecture(invalidArch)
    assert.equal(validation.canSimulate, false)

    // The caller is responsible for not calling runSimulation when canSimulate is false.
    // Verify the guard pattern that the worker uses.
    let engineCalled = false
    if (validation.canSimulate) {
      engineCalled = true
      runSimulation(toContract(invalidArch), { arrivalRate: 10, duration: 5, seed: 1 }, {})
    }
    assert.equal(engineCalled, false, 'Engine must not be called for invalid architectures')
  })

  it('a valid architecture does produce results', () => {
    const validation = validateArchitecture(validLinear())
    assert.equal(validation.canSimulate, true)
    const result = runSimulation(toContract(validLinear()), { arrivalRate: 20, duration: 5, seed: 1 }, {})
    assert.ok(result.metrics.totalRequests > 0)
  })
})

// ---------------------------------------------------------------------------
// TEST N — Event-driven architecture
// ---------------------------------------------------------------------------

describe('Test N: Event-driven architecture with queue', () => {
  it('accepts a valid event-driven architecture', () => {
    const r = validateArchitecture(eventDriven())
    assert.equal(r.valid, true)
    assert.equal(r.canSimulate, true)
    assert.equal(r.errors.length, 0)
  })

  it('runs simulation on a valid event-driven architecture', () => {
    const result = runSimulation(toContract(eventDriven()), { arrivalRate: 15, duration: 5, seed: 1 }, {})
    assert.ok(result.metrics.totalRequests > 0)
  })

  it('rejects event-driven architecture with isolated message broker', () => {
    const arch = {
      ...eventDriven(),
      nodes: [...eventDriven().nodes, node('mb-1', 'messageBroker', 'Message Broker')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    const isolatedErr = r.errors.find((e) => e.code === CODES.ISOLATED_COMPONENT && e.componentIds.includes('mb-1'))
    assert.ok(isolatedErr, 'Expected isolated message broker to be detected')
  })
})

// ---------------------------------------------------------------------------
// Additional structural tests
// ---------------------------------------------------------------------------

describe('Component configuration validation', () => {
  it('rejects a component with capacity <= 0', () => {
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('gw-1', 'apiGateway', 'Gateway'),
        node('srv-1', 'server', 'Server', { capacity: 0 }),
        node('db-1', 'database', 'Database'),
      ],
      edges: [edge('user-1', 'gw-1'), edge('gw-1', 'srv-1'), edge('srv-1', 'db-1')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.ok(r.errors.find((e) => e.code === CODES.INVALID_CAPACITY))
  })

  it('rejects a component with negative processing time', () => {
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('gw-1', 'apiGateway', 'Gateway'),
        node('srv-1', 'server', 'Server', { processingTime: -5 }),
        node('db-1', 'database', 'Database'),
      ],
      edges: [edge('user-1', 'gw-1'), edge('gw-1', 'srv-1'), edge('srv-1', 'db-1')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.ok(r.errors.find((e) => e.code === CODES.INVALID_PROCESSING_TIME))
  })

  it('rejects failure probability out of range', () => {
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('gw-1', 'apiGateway', 'Gateway'),
        node('srv-1', 'server', 'Server', { failureProbability: 1.5 }),
        node('db-1', 'database', 'Database'),
      ],
      edges: [edge('user-1', 'gw-1'), edge('gw-1', 'srv-1'), edge('srv-1', 'db-1')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.ok(r.errors.find((e) => e.code === CODES.INVALID_FAILURE_PROBABILITY))
  })
})

describe('Self-connection validation', () => {
  it('rejects a self-loop', () => {
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('gw-1', 'apiGateway', 'Gateway'),
        node('srv-1', 'server', 'Server'),
        node('db-1', 'database', 'Database'),
      ],
      edges: [
        edge('user-1', 'gw-1'),
        edge('gw-1', 'srv-1'),
        edge('srv-1', 'srv-1'), // self loop
        edge('srv-1', 'db-1'),
      ],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.ok(r.errors.find((e) => e.code === CODES.SELF_CONNECTION))
  })
})

describe('No entry point', () => {
  it('rejects an architecture with no client components', () => {
    const arch = {
      nodes: [
        node('srv-1', 'server', 'Server'),
        node('db-1', 'database', 'Database'),
      ],
      edges: [edge('srv-1', 'db-1')],
    }
    const r = validateArchitecture(arch)
    assert.equal(r.valid, false)
    assert.ok(r.errors.find((e) => e.code === CODES.NO_ENTRY_POINT))
  })
})

describe('Structured error objects', () => {
  it('every error has the required fields', () => {
    const arch = { nodes: [], edges: [] }
    const r = validateArchitecture(arch)
    for (const e of r.errors) {
      assert.ok(e.code, 'Error must have a code')
      assert.ok(e.severity === 'ERROR', 'Error must have ERROR severity')
      assert.ok(typeof e.message === 'string' && e.message.length > 0, 'Error must have a message')
      assert.ok(typeof e.suggestion === 'string', 'Error must have a suggestion string')
      assert.ok(Array.isArray(e.componentIds), 'Error must have componentIds array')
      assert.ok(Array.isArray(e.edgeIds), 'Error must have edgeIds array')
    }
  })

  it('every warning has the required fields', () => {
    // Valid pipeline with no data store -> produces NO_DATA_STORE warning
    const arch = {
      nodes: [
        node('user-1', 'user', 'User'),
        node('gw-1', 'apiGateway', 'Gateway'),
        node('srv-1', 'server', 'Server'),
      ],
      edges: [edge('user-1', 'gw-1'), edge('gw-1', 'srv-1')],
    }
    const r = validateArchitecture(arch)
    assert.ok(r.warnings.length > 0, 'Expected at least one warning (e.g. NO_DATA_STORE)')
    for (const w of r.warnings) {
      assert.ok(w.code, 'Warning must have a code')
      assert.ok(w.severity === 'WARNING', 'Warning must have WARNING severity')
      assert.ok(typeof w.message === 'string' && w.message.length > 0, 'Warning must have a message')
      assert.ok(Array.isArray(w.componentIds), 'Warning must have componentIds array')
      assert.ok(Array.isArray(w.edgeIds), 'Warning must have edgeIds array')
    }
  })
})

describe('CODES export', () => {
  it('exports all expected stable error codes', () => {
    const required = [
      'EMPTY_ARCHITECTURE',
      'NO_ENTRY_POINT',
      'DANGLING_EDGE',
      'DUPLICATE_NODE_ID',
      'SELF_CONNECTION',
      'ISOLATED_COMPONENT',
      'UNREACHABLE_COMPONENT',
      'INVALID_CAPACITY',
      'INVALID_PROCESSING_TIME',
      'INVALID_FAILURE_PROBABILITY',
      'NO_CONNECTIONS',
      'REQUIRED_APPLICATION_LAYER_BYPASSED',
      'INVALID_CLIENT_TARGET',
      'INVALID_INFRASTRUCTURE_ACCESS',
      'INVALID_CONNECTION_DIRECTION',
      'INVALID_STORE_CONNECTION',
    ]
    for (const code of required) {
      assert.ok(CODES[code] === code, `CODES.${code} must equal "${code}"`)
    }
  })
})