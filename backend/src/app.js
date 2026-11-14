import { randomUUID } from 'node:crypto'
import express from 'express'
import helmet from 'helmet'
import compression from 'compression'
import { env } from './config/index.js'
import { logger } from './config/logger.js'
import { corsOptionsDelegate } from './middleware/cors.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import routes from './routes/index.js'

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', 1)

// The API answers JSON, not documents, so most of helmet's defaults are inert here. Two
// choices matter: CORP is opened up because the browser bundle may be served from another
// origin (the CORS allowlist is the control that actually decides who may call), and the
// remaining defaults cost nothing on a JSON response.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(compression())

app.use(corsOptionsDelegate)
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// One id per request, echoed in the response and in every server-side log line for it.
// Without this a 500 in a production sink cannot be tied back to the request that caused
// it without guessing from timestamps.
app.use((req, res, next) => {
  req.id = randomUUID()
  res.setHeader('X-Request-Id', req.id)
  const startedAt = process.hrtime.bigint()
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    // Goes through the logger, not console.log, so LOG_REQUESTS=false is honoured.
    logger.request(req, res.statusCode, durationMs)
  })
  next()
})

app.use(env.apiPrefix, routes)

app.use(notFoundHandler)
app.use(errorHandler)

export default app
