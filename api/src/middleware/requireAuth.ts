import { type RequestHandler } from 'express'
import { expressjwt, UnauthorizedError, type GetVerificationKey } from 'express-jwt'
import jwksRsa from 'jwks-rsa'

type SupportedJwtAlg = 'HS256' | 'ES256' | 'RS256'

export function buildRequireAuth(): RequestHandler {
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim()

  if (!supabaseUrl && !jwtSecret) {
    console.error('⚠️  Neither SUPABASE_URL nor SUPABASE_JWT_SECRET is set!')
    console.error('Please add SUPABASE_URL and/or SUPABASE_JWT_SECRET to your .env file.')

    return (_req, res) => {
      res.status(500).json({
        success: false,
        error: 'Auth is not configured (set SUPABASE_URL and/or SUPABASE_JWT_SECRET)',
      })
    }
  }

  const issuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined
  const jwksKeyResolver = supabaseUrl
    ? (jwksRsa.expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${issuer}/.well-known/jwks.json`,
      }) as GetVerificationKey)
    : null

  const algorithms: SupportedJwtAlg[] = []
  if (jwtSecret) algorithms.push('HS256')
  if (jwksKeyResolver) algorithms.push('ES256', 'RS256')

  const getSecret: GetVerificationKey = async (req, token) => {
    const alg = token?.header?.alg
    if (alg === 'HS256') {
      if (!jwtSecret) {
        throw new UnauthorizedError('invalid_token', {
          message: 'HS256 token rejected: SUPABASE_JWT_SECRET is not configured',
        })
      }
      return jwtSecret
    }

    if (alg === 'ES256' || alg === 'RS256') {
      if (!jwksKeyResolver) {
        throw new UnauthorizedError('invalid_token', {
          message: 'JWKS verification rejected: SUPABASE_URL is not configured',
        })
      }
      try {
        return await jwksKeyResolver(req, token)
      } catch (err) {
        throw new UnauthorizedError('invalid_token', {
          message: err instanceof Error ? err.message : 'Unable to fetch signing key',
        })
      }
    }

    throw new UnauthorizedError('invalid_token', {
      message: `Unsupported JWT algorithm: ${String(alg)}`,
    })
  }

  return expressjwt({
    secret: getSecret,
    audience: 'authenticated',
    ...(issuer ? { issuer } : {}),
    algorithms,
    credentialsRequired: true,
    getToken: (req) => {
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        return undefined
      }

      return header.slice('Bearer '.length).trim()
    },
  }) as RequestHandler
}
