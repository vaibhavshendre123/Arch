import { resolveParams, nodeTypes } from '../data/nodeTypes.js'

export function toContract(architecture) {
  return {
    nodes: (architecture?.nodes || []).map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      parameters: resolveParams(n),
    })),
    edges: (architecture?.edges || [])
      .filter((e) => e.source && e.target)
      .map((e) => {
        const edge = { source: e.source, target: e.target }
        // Only carry a usable weight. An absent weight means "equal share with siblings",
        // so leaving the key out keeps the contract and its hash unchanged for ordinary
        // architectures.
        if (typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0) {
          edge.weight = e.weight
        }
        return edge
      }),
  }
}

export function contractToBuilder(contract, template = null) {
  const positions = new Map((template?.nodes || []).map((n) => [n.id, n.position]))
  return {
    nodes: (contract.nodes || []).map((n, i) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      position: positions.get(n.id) || { x: 80 + (i % 4) * 260, y: 80 + Math.floor(i / 4) * 150 },
      parameters: { ...n.parameters },
    })),
    edges: (contract.edges || []).map((e, i) => {
      const edge = {
        id: `e${i + 1}-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
      }
      if (typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0) {
        edge.weight = e.weight
      }
      return edge
    }),
  }
}

export function archHash(architecture) {
  const c = toContract(architecture)
  const str = JSON.stringify(c)
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export function graphOf(architecture) {
  const contract = toContract(architecture)
  const nodes = contract.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outgoing = new Map()
  const outgoingWeights = new Map()
  const incoming = new Map()
  for (const n of nodes) {
    outgoing.set(n.id, [])
    outgoingWeights.set(n.id, [])
    incoming.set(n.id, [])
  }
  for (const e of contract.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    outgoing.get(e.source).push(e.target)
    // Aligned with `outgoing`: null means no explicit weight, so the engine keeps its
    // existing equal-share random pick rather than introducing a weighted draw.
    outgoingWeights.get(e.source).push(
      typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0 ? e.weight : null,
    )
    incoming.get(e.target).push(e.source)
  }
  return { nodes, edges: contract.edges, byId, outgoing, incoming, outgoingWeights }
}

export function entryNodeIds(architecture) {
  const { nodes, incoming } = graphOf(architecture)
  const roots = nodes.filter((n) => (incoming.get(n.id) || []).length === 0)
  const preferred = roots.filter((n) => ['user', 'webClient', 'mobileClient'].includes(n.type))
  const chosen = preferred.length ? preferred : roots
  return chosen.map((n) => n.id)
}

export function findEntryNode(architecture) {
  const ids = entryNodeIds(architecture)
  if (!ids.length) return null
  return architecture.nodes.find((n) => n.id === ids[0]) || null
}

export function terminalNodeIds(architecture) {
  const { outgoing } = graphOf(architecture)
  return [...outgoing.entries()].filter(([, kids]) => kids.length === 0).map(([id]) => id)
}

/**
 * Enumerate expected paths by walking the architecture graph from every entry
 * node (no incoming edges) to every terminal node (no outgoing edges).
 *
 * Returns a model with the enumerated paths plus the metadata needed to tell
 * the user when the enumeration was incomplete (path budget hit) and how the
 * graph was shaped (multiple entries/terminals, cycles).
 *
 * Traversal rules:
 * - A cycle never re-enters a node already on the current path (depth-safe).
 * - Each root is walked depth-first; branching produces one path per route.
 * - Enumeration stops once `maxPaths` complete paths are collected, and the
 *   model reports `truncated: true` so the UI can say so instead of silently
 *   presenting a partial model as complete.
 */
export function expectedPathModel(architecture, maxPaths = 6) {
  const limit = Math.max(1, Math.floor(Number(maxPaths) || 6))
  const { nodes, outgoing, incoming, edges } = graphOf(architecture)
  if (!nodes.length) {
    return {
      paths: [],
      truncated: false,
      limit,
      entryIds: [],
      terminalIds: [],
      hasCycles: false,
      nodeCount: 0,
      edgeCount: 0,
    }
  }
  const starts = nodes.filter((n) => (incoming.get(n.id) || []).length === 0).map((n) => n.id)
  const roots = starts.length ? starts : [nodes[0].id]
  const terminals = nodes.filter((n) => (outgoing.get(n.id) || []).length === 0).map((n) => n.id)
  const nameOf = new Map(nodes.map((n) => [n.id, n.name || n.id]))

  // A cycle exists when a node can reach itself; the walk below avoids revisiting
  // nodes on the active path so enumeration always terminates.
  const hasCycles = (() => {
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
    return roots.some((r) => visit(r))
  })()

  const results = []
  let truncated = false
  const walk = (id, path) => {
    if (results.length >= limit) {
      truncated = true
      return
    }
    if (path.includes(id)) return
    const next = [...path, id]
    const kids = outgoing.get(id) || []
    if (!kids.length) {
      results.push(next)
      return
    }
    for (const k of kids) {
      if (results.length >= limit) {
        truncated = true
        return
      }
      walk(k, next)
    }
  }
  for (const r of roots) {
    if (results.length >= limit) {
      truncated = true
      break
    }
    walk(r, [])
  }

  return {
    paths: results.map((p) => p.map((id) => ({ id, name: nameOf.get(id) || id }))),
    truncated,
    limit,
    entryIds: roots,
    terminalIds: terminals,
    hasCycles,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  }
}

/** Backward-compatible wrapper: just the enumerated paths. */
export function expectedPaths(architecture, maxPaths = 6) {
  return expectedPathModel(architecture, maxPaths).paths
}

export function nodeLabel(architecture, id) {
  return architecture?.nodes?.find((n) => n.id === id)?.name || nodeTypes[id]?.name || id
}

export function categoryOf(node) {
  return nodeTypes[node?.type]?.cat || 'application'
}
