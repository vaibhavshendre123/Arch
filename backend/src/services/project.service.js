import { ApiError } from '../middleware/errorHandler.js'
import { assertArchitecture } from '../models/architecture.schema.js'
import ArchitectureVersion from '../models/ArchitectureVersion.model.js'
import Project from '../models/Project.model.js'

// Projects and versions both go through the same validator, so a version snapshot and a
// live project cannot disagree about what a legal architecture is. The previous private
// copy here only checked ids and references, which let unvalidated parameters through.
function assertArch(arch) {
  return assertArchitecture(arch, ApiError)
}

function toPublic(project) {
  return {
    id: project._id.toString(),
    name: project.name,
    description: project.description,
    arch: project.arch || { nodes: [], edges: [] },
    currentVersion: project.currentVersion ?? 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export async function listProjects(ownerId) {
  const projects = await Project.find({ owner: ownerId }).sort({ updatedAt: -1 })
  return projects.map(toPublic)
}

export async function getProject(id, ownerId) {
  if (!isValidId(id)) throw new ApiError(404, 'Project not found.')
  const project = await Project.findOne({ _id: id, owner: ownerId })
  if (!project) throw new ApiError(404, 'Project not found.')
  return toPublic(project)
}

export async function createProject({ ownerId, name, description, arch }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new ApiError(400, 'Project name is required.')
  if (trimmed.length > 120) throw new ApiError(400, 'Project name must be at most 120 characters.')

  let created
  try {
    created = await Project.create({
      name: trimmed,
      description: String(description || '').trim(),
      owner: ownerId,
      arch: assertArch(arch),
    })
  } catch (error) {
    if (error.statusCode) throw error
    if (error.name === 'ValidationError') {
      throw new ApiError(400, error.message)
    }
    throw error
  }
  return toPublic(created)
}

export async function updateProject(id, ownerId, patch) {
  if (!isValidId(id)) throw new ApiError(404, 'Project not found.')

  const update = {}
  if (patch.name !== undefined) {
    const trimmed = String(patch.name).trim()
    if (!trimmed) throw new ApiError(400, 'Project name cannot be empty.')
    update.name = trimmed
  }
  if (patch.description !== undefined) update.description = String(patch.description).trim()
  if (patch.arch !== undefined) update.arch = assertArch(patch.arch)

  const project = await Project.findOneAndUpdate({ _id: id, owner: ownerId }, update, {
    new: true,
    runValidators: true,
  })
  if (!project) throw new ApiError(404, 'Project not found.')
  return toPublic(project)
}

export async function deleteProject(id, ownerId) {
  if (!isValidId(id)) throw new ApiError(404, 'Project not found.')
  const project = await Project.findOne({ _id: id, owner: ownerId })
  if (!project) throw new ApiError(404, 'Project not found.')

  // Versions are keyed by project and become unreachable the moment the project row is
  // gone, so they must be removed first. That order is deliberate: if the process dies
  // between the two writes, the project is still listed with fewer versions and the delete
  // can simply be retried, whereas deleting the project first would strand the versions
  // permanently with nothing left to trigger the cleanup.
  await ArchitectureVersion.deleteMany({ project: project._id })
  await Project.deleteOne({ _id: project._id })

  return { id: project._id.toString(), name: project.name }
}

function isValidId(id) {
  return /^[a-fA-F0-9]{24}$/.test(String(id || ''))
}

export { toPublic }