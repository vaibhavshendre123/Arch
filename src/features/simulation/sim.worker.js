import { toContract, archHash } from '../../lib/contract.js'
import { runSimulation } from '../../lib/engine.js'
import { mineEventLog, miningOptions, miningProvenance } from '../../lib/mining.js'
import { evaluateArchitecture } from '../../lib/evaluation.js'
import { buildRecommendations } from '../../lib/recommendations.js'
import { analyzeCapacity } from '../../lib/capacity.js'
import { validateArchitecture } from '../../lib/validate.js'

// Two jobs: the full simulation pipeline, and the capacity sweep. The sweep runs the DES
// engine ~20 times, so it lives here rather than on the main thread.

function simulate({ architecture, workload, options }) {
  // -----------------------------------------------------------------------
  // Backend-enforcement validation guard.
  //
  // The frontend already disables the Run Simulation button when validation
  // fails, but the worker is an independent execution context that can be
  // called directly. This guard makes it impossible for the simulation
  // engine to run on an invalid architecture through any code path, even
  // if the frontend check is bypassed or stale.
  // -----------------------------------------------------------------------
  const validation = validateArchitecture(architecture)
  if (!validation.canSimulate) {
    const firstError = validation.errors[0]
    const code = firstError?.code || 'VALIDATION_FAILED'
    const message =
      firstError?.message ||
      'The architecture did not pass validation. Correct all errors in the Architecture Builder before simulating.'
    throw Object.assign(new Error(`[${code}] ${message}`), { code, validation })
  }

  const contract = toContract(architecture)
  const hash = archHash(architecture)
  const sim = runSimulation(contract, workload, options)
  // Provenance ties this mining result to the exact simulation run (seed, rate,
  // duration) and architecture hash, so results from different runs or versions
  // can never be presented as one another.
  const mining = mineEventLog(sim.eventLog, contract, {
    ...miningOptions(sim),
    provenance: miningProvenance(sim, contract, {
      archHash: hash,
      seed: workload?.seed,
      arrivalRate: workload?.arrivalRate,
      duration: workload?.duration,
    }),
  })
  const evaluation = evaluateArchitecture(contract, sim, mining)
  const recommendations = buildRecommendations(contract, sim, mining, evaluation)
  return { sim, mining, evaluation, recommendations }
}

self.onmessage = (event) => {
  const message = event.data || {}
  const { id, kind } = message
  if (!id) return

  try {
    if (kind === 'CAPACITY') {
      const capacity = analyzeCapacity(message.architecture, message.options)
      self.postMessage({ type: 'CAPACITY', id, payload: capacity })
      return
    }

    const { architecture, workload, options } = message

    // -----------------------------------------------------------------------
    // Validation check — surface as a structured ERROR response so the UI
    // can display which rules failed rather than a generic engine crash.
    // -----------------------------------------------------------------------
    const validation = validateArchitecture(architecture)
    if (!validation.canSimulate) {
      const firstError = validation.errors[0]
      const code = firstError?.code || 'VALIDATION_FAILED'
      const userMessage =
        firstError?.message ||
        'The architecture did not pass validation. Correct all errors in the Architecture Builder before simulating.'
      self.postMessage({
        type: 'ERROR',
        id,
        message: userMessage,
        code,
        validation,
        kind: 'SIMULATE',
      })
      return
    }

    const payload = simulate({ architecture, workload, options })
    self.postMessage({ type: 'RESULT', id, payload })
  } catch (error) {
    // Distinguish a validation rejection from an engine crash.
    const code = error?.code || 'ENGINE_ERROR'
    const userMessage =
      error?.code && error.code !== 'ENGINE_ERROR'
        ? error.message
        : error?.message || 'Simulation failed.'
    self.postMessage({
      type: 'ERROR',
      id,
      message: userMessage,
      code,
      validation: error?.validation || null,
      kind: kind || 'SIMULATE',
    })
  }
}
