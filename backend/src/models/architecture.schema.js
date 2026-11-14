import mongoose from 'mongoose'
import { PARAMETER_SPEC, isKnownNodeType } from './parameter-spec.js'

const { Schema } = mongoose

export const MAX_NODES = 120
export const MAX_EDGES = 120

export const nodeSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    parameters: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
)

export const edgeSchema = new Schema(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
  },
  { _id: false },
)

export const architectureSchema = new Schema(
  {
    nodes: { type: [nodeSchema], default: [] },
    edges: { type: [edgeSchema], default: [] },
  },
  { _id: false },
)

export function emptyArchitecture() {
  return { nodes: [], edges: [] }
}

function label(node) {
  return node?.name || node?.id || 'component'
}

/**
 * Validates one component's parameters against the mirrored spec and returns a normalised
 * copy. Unknown keys are rejected rather than stripped: silently dropping a key would let a
 * client believe a value was stored when it was not.
 */
function assertParameters(parameters, node, ApiError) {
  if (parameters === undefined || parameters === null) return {}
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new ApiError(400, `Parameters for "${label(node)}" must be an object.`)
  }

  const normalised = {}
  for (const [key, value] of Object.entries(parameters)) {
    const spec = PARAMETER_SPEC[key]
    if (!spec) {
      throw new ApiError(400, `Unknown parameter "${key}" on "${label(node)}".`)
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ApiError(400, `Parameter "${key}" on "${label(node)}" must be a finite number.`)
    }
    if (spec.integer && !Number.isInteger(value)) {
      throw new ApiError(400, `Parameter "${key}" on "${label(node)}" must be a whole number.`)
    }
    const belowMin = spec.minExclusive ? value <= spec.min : value < spec.min
    if (belowMin || value > spec.max) {
      const bound = spec.minExclusive ? `greater than ${spec.min}` : `at least ${spec.min}`
      throw new ApiError(
        400,
        `Parameter "${key}" on "${label(node)}" must be ${bound} and at most ${spec.max}.`,
      )
    }
    normalised[key] = value
  }
  return normalised
}

export function assertArchitecture(arch, ApiError) {
  if (!arch || typeof arch !== 'object') return emptyArchitecture()

  const nodes = Array.isArray(arch.nodes) ? arch.nodes : []
  const edges = Array.isArray(arch.edges) ? arch.edges : []

  if (nodes.length > MAX_NODES) {
    throw new ApiError(400, `An architecture may contain at most ${MAX_NODES} components.`)
  }
  if (edges.length > MAX_EDGES) {
    throw new ApiError(400, `An architecture may contain at most ${MAX_EDGES} connections.`)
  }

  const ids = new Set()
  const safeNodes = []
  for (const n of nodes) {
    if (!n?.id || !n?.type) throw new ApiError(400, 'Every component needs an id and a type.')
    if (!n?.name || !String(n.name).trim()) {
      throw new ApiError(400, `Component "${n.id}" needs a name.`)
    }
    if (ids.has(n.id)) throw new ApiError(400, `Duplicate component id: ${n.id}`)
    if (!isKnownNodeType(n.type)) {
      throw new ApiError(400, `Component "${label(n)}" has an unknown type "${n.type}".`)
    }
    ids.add(n.id)
    safeNodes.push({ ...n, parameters: assertParameters(n.parameters, n, ApiError) })
  }

  const edgeIds = new Set()
  const seen = new Set()
  for (const e of edges) {
    if (!e?.id) throw new ApiError(400, 'Every connection needs an id.')
    if (!e?.source || !e?.target) throw new ApiError(400, 'Every connection needs a source and a target.')
    if (edgeIds.has(e.id)) throw new ApiError(400, `Duplicate connection id: ${e.id}`)
    if (e.source === e.target) throw new ApiError(400, `A connection cannot point at itself (${e.id}).`)
    if (!ids.has(e.source) || !ids.has(e.target)) {
      throw new ApiError(400, 'Connection references a component that does not exist.')
    }
    if (seen.has(`${e.source}->${e.target}`)) {
      throw new ApiError(400, `Duplicate connection from "${e.source}" to "${e.target}".`)
    }
    edgeIds.add(e.id)
    seen.add(`${e.source}->${e.target}`)
  }

  return { nodes: safeNodes, edges: edges.map((e) => ({ ...e })) }
}
