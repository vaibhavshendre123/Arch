import { logger } from '../config/logger.js'

export class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.details = details
    this.isOperational = true
    Error.captureStackTrace(this, ApiError)
  }
}

export function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`))
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err)
    return
  }

  const statusCode = err.statusCode || err.status || 500
  const isServerError = statusCode >= 500

  if (isServerError) {
    // Deliberately not the error object. A stack trace, a Mongoose validation error or a
    // driver error can carry document contents and connection detail into the one log
    // stream that reaches a production sink. The request id is what ties this line back
    // to the response the caller saw.
    logger.error(
      `${req.method} ${req.originalUrl} ${statusCode} ${err.name || 'Error'}: ${err.message || 'no message'}`,
      { requestId: req.id },
    )
  }

  const body = {
    success: false,
    error: {
      message: isServerError && !err.isOperational ? 'Internal server error' : err.message,
      statusCode,
    },
  }

  if (err.details) body.error.details = err.details
  if (req.id) body.error.requestId = req.id

  res.status(statusCode).json(body)
}
