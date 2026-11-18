// Cloud auth is optional. Without these variables the editor runs locally.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const env = typeof import.meta !== 'undefined' ? (import.meta.env as Record<string, string | undefined> | undefined) : undefined
const supabaseUrl = env?.VITE_SUPABASE_URL
const supabaseAnonKey = env?.VITE_SUPABASE_ANON_KEY

export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null

export const isCloudAuthConfigured = supabase !== null
