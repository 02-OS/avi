import { useEffect, useRef, useCallback, useState } from 'react'
import { useEditorStore } from '../store/useEditorStore'
import { useAuth } from '../lib/authContext'
import {
  createProject,
  deleteProject,
  getProject,
  updateProjectComposition,
  updateProjectMetadata,
  createAutoSave,
  type Project,
} from '../lib/projectService'
import { loadProjectAssetsIntoStore, migrateProjectAssets, resolveTracksWithAssets } from '../lib/assetService'
import { normalizeTimeline, repairTracks } from '../lib/clipValidation'
import { LOCAL_PROJECT_ID, readLocalProject, writeLocalProject } from '../lib/localProject'
import { toast } from '../lib/toastStore'

export function useProjectManager() {
  const { user, loading: authLoading } = useAuth()
  const compositionTree = useEditorStore((state) => state.compositionTree)
  const totalFrames = useEditorStore((state) => state.totalFrames)
  const fps = useEditorStore((state) => state.fps)
  const hydrateProject = useEditorStore((state) => state.hydrateProject)

  const projectIdRef = useRef<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState<string>('Untitled Project')
  const [projectStatus, setProjectStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [projectError, setProjectError] = useState<string | null>(null)
  const autoSaveRef = useRef(createAutoSave(3000))
  const isInitializingRef = useRef(false)
  const isInitialized = useRef(false)
  const initInFlightRef = useRef(false)
  const hasUnsavedChangesRef = useRef(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  const setHasUnsavedChangesSync = useCallback((value: boolean) => {
    hasUnsavedChangesRef.current = value
    setHasUnsavedChanges(value)
  }, [])

  const updateProjectId = useCallback((id: string) => {
    projectIdRef.current = id
    setProjectId(id)
  }, [])

  const finishReady = useCallback((id: string, name = 'Untitled Project') => {
    updateProjectId(id)
    setProjectName(name)
    setHasUnsavedChangesSync(false)
    setProjectStatus('ready')
    isInitialized.current = true
  }, [setHasUnsavedChangesSync, updateProjectId])

  const hydrateLoadedProject = useCallback(async (project: Project, cancelled: { value: boolean }) => {
    const resolvedTracks = await resolveTracksWithAssets(project.composition_tree || [], project.fps)
    if (cancelled.value) return

    const repairedTimeline = repairTracks(resolvedTracks)
    const normalizedTimeline = normalizeTimeline(repairedTimeline.tracks)

    const missingCount = normalizedTimeline.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.assetId && clip.isMissingAsset)
      .length

    updateProjectId(project.id)
    setProjectName(project.name || 'Untitled Project')
    hydrateProject({
      tracks: normalizedTimeline.tracks,
      totalFrames: Math.max(0, project.total_frames - normalizedTimeline.offsetFrames),
      fps: project.fps,
    })
    localStorage.setItem('currentProjectId', project.id)
    setHasUnsavedChangesSync(false)
    setProjectStatus('ready')
    isInitialized.current = true
    void loadProjectAssetsIntoStore(project.id)

    if (missingCount > 0) {
      toast.warning(`${missingCount} media file${missingCount === 1 ? '' : 's'} missing from local storage. Re-upload from Assets to restore playback.`)
    }

    if (repairedTimeline.removedCount > 0 || repairedTimeline.repairedCount > 0) {
      toast.info('Timeline repaired on load.')
    }
  }, [hydrateProject, setHasUnsavedChangesSync, updateProjectId])

  const initializeLocal = useCallback(async (cancelled: { value: boolean }) => {
    if (initInFlightRef.current) return
    initInFlightRef.current = true
    isInitializingRef.current = true
    isInitialized.current = false
    autoSaveRef.current.cancel()
    setProjectStatus('loading')
    setProjectError(null)

    try {
      const saved = readLocalProject()
      const editorState = useEditorStore.getState()
      const fpsValue = saved?.fps ?? editorState.fps
      const resolvedTracks = await resolveTracksWithAssets(saved?.tracks ?? [], fpsValue)
      if (cancelled.value) return

      const repairedTimeline = repairTracks(resolvedTracks)
      const normalizedTimeline = normalizeTimeline(repairedTimeline.tracks)
      finishReady(LOCAL_PROJECT_ID, 'Local Project')
      hydrateProject({
        tracks: normalizedTimeline.tracks,
        totalFrames: Math.max(0, (saved?.totalFrames ?? editorState.totalFrames) - normalizedTimeline.offsetFrames),
        fps: fpsValue,
      })
      void loadProjectAssetsIntoStore(LOCAL_PROJECT_ID)

      const missingCount = normalizedTimeline.tracks
        .flatMap((track) => track.clips)
        .filter((clip) => clip.assetId && clip.isMissingAsset)
        .length
      if (missingCount > 0) {
        toast.warning(`${missingCount} media file${missingCount === 1 ? '' : 's'} missing from local storage. Re-import from Assets to restore playback.`)
      }
    } catch (error) {
      console.error('Local project load failed:', error)
      if (!cancelled.value) {
        setProjectError(error instanceof Error ? error.message : 'local project load failed')
        setProjectStatus('error')
      }
    } finally {
      initInFlightRef.current = false
      if (!cancelled.value) {
        isInitializingRef.current = false
      }
    }
  }, [finishReady, hydrateProject])

  const initializeProject = useCallback(async (cancelled: { value: boolean }) => {
    if (initInFlightRef.current) return
    initInFlightRef.current = true
    isInitializingRef.current = true
    isInitialized.current = false
    autoSaveRef.current.cancel()
    setProjectStatus('loading')
    setProjectError(null)

    const userId = user?.id
    if (!userId) {
      initInFlightRef.current = false
      isInitializingRef.current = false
      setProjectError('auth/session missing — please sign in again')
      setProjectStatus('error')
      return
    }

    const createFreshProject = async (editorState: {
      compositionTree: ReturnType<typeof useEditorStore.getState>['compositionTree']
      totalFrames: number
      fps: number
    }, migrateLocalAssets: boolean) => {
      const project = await createProject({
        composition_tree: editorState.compositionTree,
        total_frames: editorState.totalFrames,
        fps: editorState.fps,
      })

      if (cancelled.value) return

      if (migrateLocalAssets) {
        await migrateProjectAssets(LOCAL_PROJECT_ID, project.id)
      }

      updateProjectId(project.id)
      setProjectName(project.name || 'Untitled Project')
      localStorage.setItem('currentProjectId', project.id)
      setHasUnsavedChangesSync(false)
      setProjectStatus('ready')
      isInitialized.current = true
      void loadProjectAssetsIntoStore(project.id)
    }

    try {
      const editorState = useEditorStore.getState()
      const hasLocalTimeline = editorState.compositionTree.some((track) => track.clips.length > 0)
      if (projectIdRef.current === LOCAL_PROJECT_ID && hasLocalTimeline) {
        await createFreshProject({
          compositionTree: editorState.compositionTree,
          totalFrames: editorState.totalFrames,
          fps: editorState.fps,
        }, true)
        return
      }

      const savedProjectId = localStorage.getItem('currentProjectId')

      if (!savedProjectId) {
        const freshState = useEditorStore.getState()
        await createFreshProject({
          compositionTree: freshState.compositionTree,
          totalFrames: freshState.totalFrames,
          fps: freshState.fps,
        }, false)
        return
      }

      // Only clear currentProjectId when the project is confirmed missing (getProject returns null).
      const project = await getProject(savedProjectId)

      if (!project) {
        localStorage.removeItem('currentProjectId')
        const freshState = useEditorStore.getState()
        await createFreshProject({
          compositionTree: freshState.compositionTree,
          totalFrames: freshState.totalFrames,
          fps: freshState.fps,
        }, false)
        return
      }

      await hydrateLoadedProject(project, cancelled)
    } catch (error) {
      console.error('Project initialization failed:', error)

      if (!cancelled.value) {
        const message =
          error instanceof Error ? error.message : 'project create failed — unknown error'
        setProjectError(message)
        setProjectStatus('error')
        toast.error('Failed to set up project. Use Retry in the canvas.')
      }
    } finally {
      initInFlightRef.current = false
      if (!cancelled.value) {
        isInitializingRef.current = false
      }
    }
  }, [hydrateLoadedProject, setHasUnsavedChangesSync, updateProjectId, user])

  useEffect(() => {
    if (authLoading) return

    const cancelled = { value: false }
    if (user) {
      void initializeProject(cancelled)
    } else {
      void initializeLocal(cancelled)
    }

    return () => {
      cancelled.value = true
      autoSaveRef.current.cancel()
    }
  }, [user, authLoading, initializeProject, initializeLocal])

  const retryProjectInit = useCallback(async () => {
    initInFlightRef.current = false
    const cancelled = { value: false }
    if (!user) {
      await initializeLocal(cancelled)
      return
    }
    await initializeProject(cancelled)
  }, [user, initializeLocal, initializeProject])

  useEffect(() => {
    if (authLoading || !projectIdRef.current || isInitializingRef.current) return

    if (!isInitialized.current) {
      isInitialized.current = true
      return
    }

    if (!user) {
      writeLocalProject({ tracks: compositionTree, totalFrames, fps })
      setHasUnsavedChangesSync(false)
      return
    }

    const activeProjectId = projectIdRef.current
    setHasUnsavedChangesSync(true)

    autoSaveRef.current.schedule(async () => {
      const state = useEditorStore.getState()
      try {
        await updateProjectComposition(
          activeProjectId,
          state.compositionTree,
          state.totalFrames,
          state.fps
        )
        if (projectIdRef.current === activeProjectId) {
          setHasUnsavedChangesSync(false)
        }
      } catch (error) {
        console.error('Auto-save failed:', error)
        toast.error('Failed to auto-save. Please use the Save button.')
        throw error
      }
    })
  }, [authLoading, compositionTree, totalFrames, fps, setHasUnsavedChangesSync, user])

  const forceSave = useCallback(async () => {
    if (!user) {
      const state = useEditorStore.getState()
      writeLocalProject({
        tracks: state.compositionTree,
        totalFrames: state.totalFrames,
        fps: state.fps,
      })
      setHasUnsavedChangesSync(false)
      return
    }

    if (!projectIdRef.current) {
      throw new Error('No active project to save')
    }

    const flushed = await autoSaveRef.current.flush()
    if (!flushed || hasUnsavedChangesRef.current) {
      const state = useEditorStore.getState()
      await updateProjectComposition(
        projectIdRef.current,
        state.compositionTree,
        state.totalFrames,
        state.fps
      )
      autoSaveRef.current.cancel()
      setHasUnsavedChangesSync(false)
    }
  }, [setHasUnsavedChangesSync, user])

  const switchProject = useCallback(async (targetProjectId: string) => {
    if (!user) return
    if (targetProjectId === projectIdRef.current) return

    if (hasUnsavedChangesRef.current && projectIdRef.current) {
      await forceSave()
    }
    autoSaveRef.current.cancel()

    isInitializingRef.current = true
    setProjectStatus('loading')
    try {
      const project = await getProject(targetProjectId)
      if (!project) {
        toast.error('Project could not be found.')
        setProjectStatus('ready')
        return
      }
      await hydrateLoadedProject(project, { value: false })
      toast.success(`Switched to "${project.name}"`)
    } finally {
      isInitializingRef.current = false
    }
  }, [forceSave, hydrateLoadedProject, user])

  const createNewCloudProject = useCallback(async (name: string) => {
    if (!user) return

    if (hasUnsavedChangesRef.current && projectIdRef.current) {
      await forceSave()
    }
    autoSaveRef.current.cancel()

    isInitializingRef.current = true
    try {
      const project = await createProject({
        name: name.trim() || 'Untitled Project',
        fps: 30,
        total_frames: 150,
        composition_tree: [],
      })
      await hydrateLoadedProject(project, { value: false })
      toast.success(`Created "${project.name}"`)
    } finally {
      isInitializingRef.current = false
    }
  }, [forceSave, hydrateLoadedProject, user])

  const renameProjectById = useCallback(async (targetProjectId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    await updateProjectMetadata(targetProjectId, { name: trimmed })
    if (projectIdRef.current === targetProjectId) {
      setProjectName(trimmed)
    }
    toast.success(`Renamed project to "${trimmed}"`)
  }, [])

  const deleteProjectById = useCallback(async (targetProjectId: string) => {
    await deleteProject(targetProjectId)
    if (projectIdRef.current === targetProjectId) {
      localStorage.removeItem('currentProjectId')
      autoSaveRef.current.cancel()
      await initializeProject({ value: false })
    }
    toast.success('Project deleted')
  }, [initializeProject])

  useEffect(() => {
    const handleReconnect = () => {
      if (!projectIdRef.current || !user) return
      void (async () => {
        const flushed = await autoSaveRef.current.flush()
        if (!flushed || hasUnsavedChangesRef.current) {
          const state = useEditorStore.getState()
          await updateProjectComposition(
            projectIdRef.current!,
            state.compositionTree,
            state.totalFrames,
            state.fps
          )
          autoSaveRef.current.cancel()
          setHasUnsavedChangesSync(false)
        }
      })().catch((err) => {
        console.error('Reconnect save failed:', err)
        toast.error('Reconnect sync failed. Please use the Save button.')
      })
    }

    window.addEventListener('avi:reconnect', handleReconnect)
    return () => window.removeEventListener('avi:reconnect', handleReconnect)
  }, [setHasUnsavedChangesSync, user])

  useEffect(() => {
    if (!hasUnsavedChanges) return

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  return {
    projectId,
    projectName,
    projectStatus,
    projectError,
    retryProjectInit,
    forceSave,
    hasUnsavedChanges,
    switchProject,
    createNewCloudProject,
    renameProjectById,
    deleteProjectById,
  }
}
