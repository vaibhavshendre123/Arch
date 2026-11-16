import { resolveParams, isClient, isStore, nodeTypes } from '../data/nodeTypes.js'
import { graphOf, entryNodeIds, terminalNodeIds } from './contract.js'

// ---------------------------------------------------------------------------
// Error codes (stable — used by tests and by the UI to handle results)
// ---------------------------------------------------------------------------
export const CODES = {
  EMPTY_ARCHITECTURE: 'EMPTY_ARCHITECTURE',
  NO_ENTRY_POINT: 'NO_ENTRY_POINT',
  DANGLING_EDGE: 'DANGLING_EDGE',
  DUPLICATE_NODE_ID: 'DUPLICATE_NODE_ID',
  SELF_CONNECTION: 'SELF_CONNECTION',
  DUPLICATE_EDGE: 'DUPLICATE_EDGE',
  ISOLATED_COMPONENT: 'ISOLATED_COMPONENT',
  UNREACHABLE_COMPONENT: 'UNREACHABLE_COMPONENT',
  INVALID_CAPACITY: 'INVALID_CAPACITY',
  INVALID_PROCESSING_TIME: 'INVALID_PROCESSING_TIME',
  INVALID_FAILURE_PROBABILITY: 'INVALID_FAILURE_PROBABILITY',
  INVALID_QUEUE_CAPACITY: 'INVALID_QUEUE_CAPACITY',
  INVALID_SERVICE_TIME_CV: 'INVALID_SERVICE_TIME_CV',
  INVALID_EDGE_WEIGHT: 'INVALID_EDGE_WEIGHT',
  NO_CONNECTIONS: 'NO_CONNECTIONS',
  UNKNOWN_NODE_TYPE: 'UNKNOWN_NODE_TYPE',
  // Architectural rules
  REQUIRED_APPLICATION_LAYER_BYPASSED: 'REQUIRED_APPLICATION_LAYER_BYPASSED',
  INVALID_CLIENT_TARGET: 'INVALID_CLIENT_TARGET',
  INVALID_INFRASTRUCTURE_ACCESS: 'INVALID_INFRASTRUCTURE_ACCESS',
  INVALID_CONNECTION_DIRECTION: 'INVALID_CONNECTION_DIRECTION',
  INVALID_STORE_CONNECTION: 'INVALID_STORE_CONNECTION',
  // Warnings (non-blocking)
  NO_TERMINAL: 'NO_TERMINAL',
  NO_DATA_STORE: 'NO_DATA_STORE',
  CYCLE_DETECTED: 'CYCLE_DETECTED',
  MULTIPLE_ENTRY_POINTS: 'MULTIPLE_ENTRY_POINTS',
}

const CLIENT_TYPES = ['user', 'webClient', 'mobileClient']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(code, message, suggestion, componentIds = [], edgeIds = []) {
  return { code, severity: 'ERROR', message, suggestion, componentIds, edgeIds }
}

function warn(code, message, suggestion, componentIds = [], edgeIds = []) {
  return { code, severity: 'WARNING', message, suggestion, componentIds, edgeIds }
}

// ---------------------------------------------------------------------------
// Graph traversal utilities
// ---------------------------------------------------------------------------

export function detectCycles(outgoing, ids) {
  const state = new Map()
  const visit = (id) => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    for (const kid of outgoing.get(id) || []) {
      if (visit(kid)) return true
    }
    state.set(id, 2)
    return false
  }
  return ids.some((id) => visit(id))
}

export function reachableFrom(outgoing, starts, allIds) {
  const seen = new Set()
  const stack = [...starts]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const kid of outgoing.get(id) || []) {
      if (allIds.includes(kid)) stack.push(kid)
    }
  }
  return seen
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate an architecture graph and return a structured result.
 *
 * Returns:
 *   {
 *     valid: boolean,        // true iff no ERROR-severity findings
 *     canSimulate: boolean,  // same as valid (simulation requires no blocking errors)
 *     errors: Finding[],     // blocking errors
 *     warnings: Finding[],   // non-blocking warnings
 *     info: Finding[],       // informational only
 *   }
 *
 * Each Finding:
 *   { code, severity, message, suggestion, componentIds, edgeIds }
 */
export function validateArchitecture(architecture) {
  const errors = []
  const warnings = []
  const infoItems = []

  const nodes = architecture?.nodes || []
  const edges = architecture?.edges || []

  // ------------------------------------------------------------------
  // 5.1 Empty architecture
  // ------------------------------------------------------------------
  if (!nodes.length) {
    errors.push(
      err(
        CODES.EMPTY_ARCHITECTURE,
        'The architecture contains no components.',
        'Add the components needed for your architecture using the Component Palette.',
      ),
    )
    return { valid: false, canSimulate: false, errors, warnings, info: infoItems }
  }

  // ------------------------------------------------------------------
  // 5.2a Duplicate node IDs
  // ------------------------------------------------------------------
  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  if (idSet.size !== ids.length) {
    const seen = new Set()
    const dupes = []
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id)
      seen.add(id)
    }
    errors.push(
      err(
        CODES.DUPLICATE_NODE_ID,
        `Duplicate component IDs detected: ${dupes.join(', ')}.`,
        'Each component must have a unique identifier. Delete and re-add the duplicated components.',
        dupes,
      ),
    )
  }

  // ------------------------------------------------------------------
  // 5.2b Unknown node types
  // ------------------------------------------------------------------
  for (const n of nodes) {
    if (n.type && !nodeTypes[n.type]) {
      errors.push(
        err(
          CODES.UNKNOWN_NODE_TYPE,
          `Component "${n.name || n.id}" has an unknown type "${n.type}".`,
          'Remove this component and replace it with a supported type from the Component Palette.',
          [n.id],
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // 5.2c Invalid edge references
  // ------------------------------------------------------------------
  for (const e of edges) {
    const edgeLabel = e.id || `${e.source}->${e.target}`
    if (!e.source || !e.target) {
      errors.push(
        err(
          CODES.DANGLING_EDGE,
          `Connection "${edgeLabel}" is missing a source or target endpoint.`,
          'Delete this connection and recreate it between two valid components.',
          [],
          [e.id].filter(Boolean),
        ),
      )
      continue
    }
    if (!idSet.has(e.source)) {
      errors.push(
        err(
          CODES.DANGLING_EDGE,
          `Connection "${edgeLabel}" references a source component that does not exist.`,
          'Delete this connection. The component it points from has been removed.',
          [],
          [e.id].filter(Boolean),
        ),
      )
    }
    if (!idSet.has(e.target)) {
      errors.push(
        err(
          CODES.DANGLING_EDGE,
          `Connection "${edgeLabel}" references a target component that does not exist.`,
          'Delete this connection. The component it points to has been removed.',
          [],
          [e.id].filter(Boolean),
        ),
      )
    }
    if (e.weight !== undefined && e.weight !== null) {
      const weight = e.weight
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        errors.push(
          err(
            CODES.INVALID_EDGE_WEIGHT,
            `Connection "${edgeLabel}" has an invalid weight (${String(weight)}); it must be a finite number greater than zero.`,
            'Set a positive weight, or leave it blank to split traffic equally with its sibling connections.',
            [],
            [e.id].filter(Boolean),
          ),
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // 5.3a Self-connections
  // ------------------------------------------------------------------
  for (const e of edges) {
    if (e.source && e.source === e.target) {
      errors.push(
        err(
          CODES.SELF_CONNECTION,
          `Component "${e.source}" has a connection to itself.`,
          'Remove the self-connection. A component cannot process requests it sends to itself.',
          [e.source],
          [e.id].filter(Boolean),
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // 5.3b Duplicate edges
  // ------------------------------------------------------------------
  const edgeKeys = new Set()
  for (const e of edges) {
    if (!e.source || !e.target || e.source === e.target) continue
    const key = `${e.source}-->${e.target}`
    if (edgeKeys.has(key)) {
      errors.push(
        err(
          CODES.DUPLICATE_EDGE,
          `There are multiple connections from "${e.source}" to "${e.target}".`,
          'Remove the duplicate connection. Only one directed connection between the same pair of components is needed.',
          [e.source, e.target],
          [e.id].filter(Boolean),
        ),
      )
    } else {
      edgeKeys.add(key)
    }
  }

  // ------------------------------------------------------------------
  // 5.3c Architectural Compatibility Rules
  // ------------------------------------------------------------------
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  for (const e of edges) {
    if (!e.source || !e.target || e.source === e.target) continue
    const src = nodeMap.get(e.source)
    const tgt = nodeMap.get(e.target)
    if (!src || !tgt) continue

    const srcType = src.type
    const tgtType = tgt.type
    const srcCat = nodeTypes[srcType]?.cat || 'application'
    const tgtCat = nodeTypes[tgtType]?.cat || 'application'
    const edgeId = [e.id].filter(Boolean)
    const compIds = [src.id, tgt.id]

    // Rule 1: Clients cannot connect directly to data storage (bypasses application layer)
    if (srcCat === 'client' && tgtCat === 'data') {
      errors.push(
        err(
          CODES.REQUIRED_APPLICATION_LAYER_BYPASSED,
          `Direct connection from "${src.name || src.id}" to "${tgt.name || tgt.id}" bypasses the required application layer.`,
          `Client components cannot directly access protected data storage (${nodeTypes[tgtType]?.name || tgtType}). Route requests through an application service (API Gateway, Load Balancer, Server, or Microservice).`,
          compIds,
          edgeId,
        ),
      )
    }

    // Rule 2: User actor direct connection constraints
    if (srcType === 'user') {
      if (tgtType === 'queue' || tgtType === 'messageBroker') {
        errors.push(
          err(
            CODES.INVALID_INFRASTRUCTURE_ACCESS,
            `User "${src.name || src.id}" cannot connect directly to internal messaging component "${tgt.name || tgt.id}".`,
            `Users must interact through a client application (Web Client, Mobile Client) or API Gateway. Route requests through an application service before queuing.`,
            compIds,
            edgeId,
          ),
        )
      } else if (tgtType === 'server' || tgtType === 'microservice') {
        errors.push(
          err(
            CODES.INVALID_CLIENT_TARGET,
            `Direct connection from User "${src.name || src.id}" to backend service "${tgt.name || tgt.id}" bypasses the client or gateway tier.`,
            `Users must interact through a Web Client, Mobile Client, or an entry gateway (API Gateway, Load Balancer), not directly to internal servers.`,
            compIds,
            edgeId,
          ),
        )
      } else if (tgtType === 'externalService') {
        errors.push(
          err(
            CODES.INVALID_CLIENT_TARGET,
            `Direct connection from User "${src.name || src.id}" to External Service "${tgt.name || tgt.id}" is invalid.`,
            `Users must interact through an application client (Web/Mobile Client) or API Gateway.`,
            compIds,
            edgeId,
          ),
        )
      }
    }

    // Rule 3: Web/Mobile client direct to internal message queue
    if ((srcType === 'webClient' || srcType === 'mobileClient') && (tgtType === 'queue' || tgtType === 'messageBroker')) {
      errors.push(
        err(
          CODES.INVALID_INFRASTRUCTURE_ACCESS,
          `Client component "${src.name || src.id}" cannot connect directly to internal messaging component "${tgt.name || tgt.id}".`,
          `Clients must communicate with an API Gateway or backend application service, which then publishes to the message queue.`,
          compIds,
          edgeId,
        ),
      )
    }

    // Rule 4: Storage component cannot initiate connections to clients or entry gateways
    if (srcCat === 'data' && (tgtCat === 'client' || tgtType === 'apiGateway' || tgtType === 'loadBalancer')) {
      errors.push(
        err(
          CODES.INVALID_CONNECTION_DIRECTION,
          `Storage component "${src.name || src.id}" cannot initiate connections to "${tgt.name || tgt.id}".`,
          `Data storage components are passive query targets. Connect services to "${src.name || src.id}", not the reverse.`,
          compIds,
          edgeId,
        ),
      )
    }

    // Rule 5: Internal queue/broker cannot push directly to user or clients
    if ((srcType === 'queue' || srcType === 'messageBroker') && (tgtType === 'user' || tgtType === 'webClient' || tgtType === 'mobileClient')) {
      errors.push(
        err(
          CODES.INVALID_CONNECTION_DIRECTION,
          `Message component "${src.name || src.id}" cannot route directly to client "${tgt.name || tgt.id}".`,
          `Queues must be consumed by backend services (Server or Microservice), which then respond to clients.`,
          compIds,
          edgeId,
        ),
      )
    }

    // Rule 6: Passive storage to passive storage without compute
    if ((srcType === 'database' || srcType === 'fileStorage') && (tgtType === 'database' || tgtType === 'fileStorage')) {
      errors.push(
        err(
          CODES.INVALID_STORE_CONNECTION,
          `Direct connection between storage components "${src.name || src.id}" and "${tgt.name || tgt.id}" is not supported.`,
          `Place an application component (Server or Microservice) between data stores to coordinate data synchronization.`,
          compIds,
          edgeId,
        ),
      )
    }

    // Rule 7: Nothing routes into User (User is traffic initiator)
    if (tgtType === 'user' && srcCat === 'client') {
      errors.push(
        err(
          CODES.INVALID_CLIENT_TARGET,
          `"${src.name || src.id}" cannot connect to User "${tgt.name || tgt.id}".`,
          `Users are request initiators and entry points; they do not receive direct downstream request connections.`,
          compIds,
          edgeId,
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // 5.4 Component configuration validation
  // ------------------------------------------------------------------
  for (const n of nodes) {
    const p = resolveParams(n)
    if (p.capacity !== undefined && p.capacity <= 0) {
      errors.push(
        err(
          CODES.INVALID_CAPACITY,
          `"${n.name || n.id}" has a capacity of ${p.capacity}; it must be greater than zero.`,
          'Open the component properties and set capacity to at least 1.',
          [n.id],
        ),
      )
    }
    if (p.processingTime !== undefined && p.processingTime < 0) {
      errors.push(
        err(
          CODES.INVALID_PROCESSING_TIME,
          `"${n.name || n.id}" has a negative processing time (${p.processingTime} ms).`,
          'Open the component properties and set a processing time of 0 ms or greater.',
          [n.id],
        ),
      )
    }
    if (p.failureProbability !== undefined && (p.failureProbability < 0 || p.failureProbability > 1)) {
      errors.push(
        err(
          CODES.INVALID_FAILURE_PROBABILITY,
          `"${n.name || n.id}" has a failure probability of ${p.failureProbability}; it must be between 0 and 1.`,
          'Open the component properties and set a failure probability between 0 and 1.',
          [n.id],
        ),
      )
    }
    if (p.queueCapacity !== undefined && p.queueCapacity < 0) {
      errors.push(
        err(
          CODES.INVALID_QUEUE_CAPACITY,
          `"${n.name || n.id}" has a negative queue capacity (${p.queueCapacity}).`,
          'Open the component properties and set a queue capacity of 0 or greater.',
          [n.id],
        ),
      )
    }
    if (p.serviceTimeCv !== undefined) {
      const cv = p.serviceTimeCv
      if (typeof cv !== 'number' || !Number.isFinite(cv) || cv < 0 || cv > 2) {
        errors.push(
          err(
            CODES.INVALID_SERVICE_TIME_CV,
            `"${n.name || n.id}" has a service time coefficient of variation of ${String(cv)}; it must be between 0 and 2.`,
            'Open the component properties and set the service time CV between 0 (fixed duration) and 2.',
            [n.id],
          ),
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // Entry point check
  // ------------------------------------------------------------------
  const hasEntry = nodes.some((n) => CLIENT_TYPES.includes(n.type))
  if (!hasEntry) {
    errors.push(
      err(
        CODES.NO_ENTRY_POINT,
        'No entry point found. The architecture needs a client component to generate requests.',
        'Add a User, Web Client, or Mobile Client component to serve as the entry point for incoming requests.',
      ),
    )
  }

  // ------------------------------------------------------------------
  // No connections at all
  // ------------------------------------------------------------------
  if (!edges.length && nodes.length > 1) {
    errors.push(
      err(
        CODES.NO_CONNECTIONS,
        'No connections exist between components.',
        'Draw connections between your components so that requests can flow through the architecture.',
      ),
    )
    // Can't do reachability checks without edges; return early with what we have.
    return { valid: errors.length === 0, canSimulate: errors.length === 0, errors, warnings, info: infoItems }
  }

  // ------------------------------------------------------------------
  // 6.2 Isolated components (no connections at all)
  // ------------------------------------------------------------------
  const connectedIds = new Set()
  for (const e of edges) {
    if (e.source) connectedIds.add(e.source)
    if (e.target) connectedIds.add(e.target)
  }

  for (const n of nodes) {
    if (!connectedIds.has(n.id)) {
      errors.push(
        err(
          CODES.ISOLATED_COMPONENT,
          `"${n.name || n.id}" (${nodeTypes[n.type]?.name || n.type}) is not connected to any other component.`,
          `Connect "${n.name || n.id}" to an appropriate component in the request flow, or remove it if it is not needed.`,
          [n.id],
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // Graph-based checks: use graphOf() for directed traversal
  // ------------------------------------------------------------------
  const { outgoing } = graphOf(architecture)
  const nodeIdList = nodes.map((n) => n.id)

  // ------------------------------------------------------------------
  // 6 Cycle detection
  // ------------------------------------------------------------------
  const hasCycles = detectCycles(outgoing, nodeIdList)
  if (hasCycles) {
    warnings.push(
      warn(
        CODES.CYCLE_DETECTED,
        'The architecture contains a cycle (a feedback or retry loop).',
        'This is allowed. The simulation will cap traversal depth to prevent infinite routing. Review the cycle to ensure it represents an intentional feedback path.',
      ),
    )
  }

  // ------------------------------------------------------------------
  // 6.1 Entry points
  // ------------------------------------------------------------------
  const entries = entryNodeIds(architecture)
  if (entries.length > 1) {
    warnings.push(
      warn(
        CODES.MULTIPLE_ENTRY_POINTS,
        `${entries.length} entry points detected. Incoming workload will be distributed across all of them.`,
        'This is valid for multi-client architectures. Ensure each entry point has the correct downstream connections.',
        entries,
      ),
    )
  }

  // ------------------------------------------------------------------
  // 6.3 Unreachable components
  // ------------------------------------------------------------------
  if (entries.length > 0) {
    const reachable = reachableFrom(outgoing, entries, nodeIdList)
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        // If it is also isolated, the isolated error already covers it — avoid duplicate messages
        if (!connectedIds.has(n.id)) continue
        errors.push(
          err(
            CODES.UNREACHABLE_COMPONENT,
            `"${n.name || n.id}" (${nodeTypes[n.type]?.name || n.type}) cannot be reached from the entry point.`,
            `Check the direction of connections leading to "${n.name || n.id}". Make sure the path from the entry point can reach it.`,
            [n.id],
          ),
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // 6.5 Terminal paths
  // ------------------------------------------------------------------
  const terminals = terminalNodeIds(architecture)
  if (!terminals.length && edges.length) {
    warnings.push(
      warn(
        CODES.NO_TERMINAL,
        'No terminal component found — every component routes onward with no end point.',
        'Ensure at least one component in the final processing layer (e.g. Database, File Storage) has no outgoing connections, so requests can complete.',
      ),
    )
  }

  // ------------------------------------------------------------------
  // Warning: no data store
  // ------------------------------------------------------------------
  if (!nodes.some((n) => isStore(n))) {
    warnings.push(
      warn(
        CODES.NO_DATA_STORE,
        'No persistent data store (Database or File Storage) was found.',
        'Consider adding a Database or File Storage component if your architecture needs to persist data.',
      ),
    )
  }

  return {
    valid: errors.length === 0,
    canSimulate: errors.length === 0,
    errors,
    warnings,
    info: infoItems,
  }
}

// ---------------------------------------------------------------------------
// canSimulate: convenience guard for UI and worker
// Uses the full validation rules, not a simplified heuristic.
// ---------------------------------------------------------------------------

/**
 * Returns true only if the architecture passes full validation.
 * Use this instead of writing ad-hoc structural checks.
 */
export function canSimulate(architecture) {
  if (!architecture?.nodes?.length) return false
  if (!architecture?.edges?.length) return false
  if (!architecture.nodes.some((n) => isClient(n))) return false
  // Run the full validator to catch structural problems
  const result = validateArchitecture(architecture)
  return result.canSimulate
}

// ---------------------------------------------------------------------------
// Legacy compat: plain string arrays for parts of the codebase that read
// result.errors as strings rather than objects.
// ---------------------------------------------------------------------------

/**
 * Returns the same result as validateArchitecture, but also includes
 * .errorMessages and .warningMessages as string arrays for backward compat.
 */
export function validateArchitectureFull(architecture) {
  const result = validateArchitecture(architecture)
  return {
    ...result,
    errorMessages: result.errors.map((e) => e.message),
    warningMessages: result.warnings.map((w) => w.message),
  }
}
