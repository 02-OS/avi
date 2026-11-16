// Required environment variables are documented in the repo root .env.example.
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import rateLimit from 'express-rate-limit'
import promptRouter from './routes/prompt'
import projectsRouter from './routes/projects'
import { buildRequireAuth } from './middleware/requireAuth'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 4000
const DEFAULT_CORS_ORIGINS = [
  'http://127.0.0.1:1420',
  'http://localhost:1420',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]
const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const corsOrigin = Array.from(
  new Set(configuredOrigins.length > 0 ? [...configuredOrigins, 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'] : DEFAULT_CORS_ORIGINS)
)
const promptLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true })
const requireAuth = buildRequireAuth()

// Middleware
app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json({ limit: '2mb' }))

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'avi-api', timestamp: new Date().toISOString() })
})

// Routes
app.use('/api/prompt', promptLimiter, requireAuth, promptRouter)
app.use('/api/projects', requireAuth, projectsRouter)

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UnauthorizedError'
  ) {
    const status = 'status' in error && typeof error.status === 'number' ? error.status : 401
    res.status(status).json({ success: false, error: 'Unauthorized' })
    return
  }

  next(error)
})

app.listen(PORT, () => {
  console.log(`[api] Server running on http://localhost:${PORT}`)
})

export default app
