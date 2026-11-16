import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { type AuthError, type Session, type User } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'
import { isDesktopApp, openExternalUrl, startOAuthLoopback } from './desktop'

const unavailable = (message: string) => ({ message }) as AuthError

interface AuthContextType {
  user: User | null
  session: Session | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: AuthError | null }>
  signInWithGitHub: () => Promise<{ error: AuthError | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const applySession = (nextSession: Session | null) => {
      if (cancelled) return
      setSession(nextSession)
      setUser(nextSession?.user ?? null)
      setLoading(false)
    }

    const clearToLogin = (error: unknown) => {
      console.error('Supabase auth session failed and was cleared:', error)
      applySession(null)
    }

    if (!supabase) {
      applySession(null)
      return
    }

    const client = supabase

    // Get initial session
    ;(async () => {
      try {
        const { data, error } = await client.auth.getSession()
        if (error) {
          clearToLogin(error)
          return
        }
        applySession(data.session)
      } catch (error) {
        clearToLogin(error)
      }
    })()

    // Listen for auth changes
    const { data: { subscription } } = client.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'TOKEN_REFRESHED' && !nextSession) {
        clearToLogin(new Error('Token refresh returned an empty session'))
        return
      }

      applySession(nextSession)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !isDesktopApp()) return

    let unlisten: (() => void) | undefined
    let cancelled = false
    const client = supabase

    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen<string>('avi://oauth-callback', async (event) => {
        try {
          const parsed = new URL(event.payload)
          const code = parsed.searchParams.get('code')
          if (code) {
            const { error } = await client.auth.exchangeCodeForSession(code)
            if (error) {
              console.error('OAuth code exchange failed:', error)
            }
            return
          }

          const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
          const hashParams = new URLSearchParams(hash)
          const accessToken = hashParams.get('access_token')
          const refreshToken = hashParams.get('refresh_token')
          if (accessToken && refreshToken) {
            const { error } = await client.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            })
            if (error) {
              console.error('OAuth session hydration failed:', error)
            }
          }
        } catch (err) {
          console.error('Failed to process desktop OAuth callback:', err)
        }
      })

      if (cancelled) {
        stop()
        return
      }
      unlisten = stop
    }).catch((err) => {
      console.error('Failed to register OAuth callback listener:', err)
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const signIn = async (email: string, password: string) => {
    if (!supabase) return { error: unavailable('Cloud sign-in is not configured') }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  const signUp = async (email: string, password: string, fullName?: string) => {
    if (!supabase) return { error: unavailable('Cloud sign-in is not configured') }
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
      },
    })
    return { error }
  }

  const signInWithGitHub = async () => {
    if (!supabase) return { error: unavailable('Cloud sign-in is not configured') }

    if (isDesktopApp()) {
      try {
        const redirectTo = await startOAuthLoopback()
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: 'github',
          options: {
            redirectTo,
            skipBrowserRedirect: true,
          },
        })
        if (error) return { error }
        if (!data?.url) {
          return { error: unavailable('Failed to initialize OAuth sign-in URL') }
        }
        await openExternalUrl(data.url)
        return { error: null }
      } catch (err) {
        return {
          error: unavailable(err instanceof Error ? err.message : 'Desktop OAuth failed to start'),
        }
      }
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: window.location.origin,
      },
    })
    return { error }
  }

  const signOut = async () => {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }

  const value = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signInWithGitHub,
    signOut,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
