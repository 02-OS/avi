import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Router, type Response } from 'express'
import { type Request as JWTRequest } from 'express-jwt'
import { z } from 'zod'

const router = Router()

const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  fps: z.number().int().positive().max(120).optional(),
  total_frames: z.number().int().positive().optional(),
  composition_tree: z.array(z.unknown()).optional(),
})

const UpdateProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  thumbnail_url: z.string().max(2000).nullable().optional(),
  fps: z.number().int().positive().max(120).optional(),
  total_frames: z.number().int().positive().optional(),
  composition_tree: z.array(z.unknown()).optional(),
})

function userSupabaseClient(req: JWTRequest): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL?.trim()
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim()
  const authHeader = req.headers.authorization

  if (!supabaseUrl || !supabaseAnonKey || !authHeader) {
    return null
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  })
}

router.get('/', async (req: JWTRequest, res: Response): Promise<void> => {
  const client = userSupabaseClient(req)
  if (!client) {
    res.status(503).json({
      success: false,
      error: 'Supabase persistence is not configured on the API server (SUPABASE_URL / SUPABASE_ANON_KEY)',
    })
    return
  }

  const { data, error } = await client
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false })

  if (error) {
    res.status(500).json({ success: false, error: error.message })
    return
  }

  res.json({ success: true, projects: data ?? [] })
})

router.post('/', async (req: JWTRequest, res: Response): Promise<void> => {
  const parsed = CreateProjectSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: 'Invalid project payload',
      details: parsed.error.flatten(),
    })
    return
  }

  const client = userSupabaseClient(req)
  if (!client) {
    res.status(503).json({
      success: false,
      error: 'Supabase persistence is not configured on the API server',
    })
    return
  }

  const userId = typeof req.auth?.sub === 'string' ? req.auth.sub : undefined
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized: missing user subject' })
    return
  }

  const { data, error } = await client
    .from('projects')
    .insert({
      user_id: userId,
      name: parsed.data.name ?? 'Untitled Project',
      description: parsed.data.description ?? null,
      fps: parsed.data.fps ?? 30,
      total_frames: parsed.data.total_frames ?? 150,
      composition_tree: parsed.data.composition_tree ?? [],
    })
    .select()
    .single()

  if (error) {
    res.status(500).json({ success: false, error: error.message })
    return
  }

  res.status(201).json({ success: true, project: data })
})

router.get('/:id', async (req: JWTRequest, res: Response): Promise<void> => {
  const client = userSupabaseClient(req)
  if (!client) {
    res.status(503).json({
      success: false,
      error: 'Supabase persistence is not configured on the API server',
    })
    return
  }

  const { data, error } = await client
    .from('projects')
    .select('*')
    .eq('id', req.params.id)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      res.status(404).json({ success: false, error: 'Project not found' })
      return
    }
    res.status(500).json({ success: false, error: error.message })
    return
  }

  res.json({ success: true, project: data })
})

router.patch('/:id', async (req: JWTRequest, res: Response): Promise<void> => {
  const parsed = UpdateProjectSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: 'Invalid project update payload',
      details: parsed.error.flatten(),
    })
    return
  }

  const client = userSupabaseClient(req)
  if (!client) {
    res.status(503).json({
      success: false,
      error: 'Supabase persistence is not configured on the API server',
    })
    return
  }

  const { data, error } = await client
    .from('projects')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      res.status(404).json({ success: false, error: 'Project not found' })
      return
    }
    res.status(500).json({ success: false, error: error.message })
    return
  }

  res.json({ success: true, project: data })
})

router.delete('/:id', async (req: JWTRequest, res: Response): Promise<void> => {
  const client = userSupabaseClient(req)
  if (!client) {
    res.status(503).json({
      success: false,
      error: 'Supabase persistence is not configured on the API server',
    })
    return
  }

  const { error } = await client.from('projects').delete().eq('id', req.params.id)

  if (error) {
    res.status(500).json({ success: false, error: error.message })
    return
  }

  res.json({ success: true })
})

export default router
