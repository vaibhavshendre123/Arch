import { env } from '../config/index.js'
import {
  consumeAdvisorQuota,
  generateGeminiChatAnswer,
  generateGeminiRecommendations,
  isAdvisorConfigured,
} from '../services/recommendation.service.js'

/** Lets the page show "not configured" without provoking a failed request. */
export function advisorStatusHandler(req, res) {
  res.status(200).json({
    success: true,
    data: {
      configured: isAdvisorConfigured(),
      model: isAdvisorConfigured() ? env.geminiModel : null,
      maxPerWindow: env.advisorMaxPerWindow,
    },
  })
}

export async function generateAdvisorHandler(req, res) {
  // Quota is consumed before the call so a burst cannot fan out into parallel requests.
  consumeAdvisorQuota(req.user.id)

  const result = await generateGeminiRecommendations((req.body || {}).evidence)
  res.status(200).json({
    success: true,
    data: {
      configured: true,
      model: result.model,
      temperature: result.temperature,
      recommendations: result.recommendations,
    },
  })
}

/** Conversational arm: same evidence and quota guard, no change to the /advisor contract. */
export async function advisorChatHandler(req, res) {
  consumeAdvisorQuota(req.user.id)

  const body = req.body || {}
  const result = await generateGeminiChatAnswer({ question: body.question, history: body.history }, body.evidence)
  res.status(200).json({
    success: true,
    data: {
      configured: true,
      model: result.model,
      temperature: result.temperature,
      answer: result.answer,
      bullets: result.bullets,
      caveats: result.caveats,
    },
  })
}