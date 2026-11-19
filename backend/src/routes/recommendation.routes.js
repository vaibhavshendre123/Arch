import { Router } from 'express'
import {
  advisorChatHandler,
  advisorStatusHandler,
  generateAdvisorHandler,
} from '../controllers/recommendation.controller.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// This router spends paid Gemini quota on every call, so it is always behind auth.
router.use(requireAuth)

router.get('/advisor', advisorStatusHandler)
router.post('/advisor', generateAdvisorHandler)
// Additive route: the two existing /advisor endpoints above keep their contracts.
router.post('/advisor/chat', advisorChatHandler)

export default router