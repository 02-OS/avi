import { create } from 'zustand'
import { type Track, useEditorStore } from '../store/useEditorStore'
import {
  allowMediaPath,
  deletePlaybackProxy,
  desktopMediaUrl,
  ffmpegAvailable,
  generatePlaybackProxy,
  isDesktopApp,
  isSupportedMediaPath,
  localFileSize,
} from './desktop'
import { LOCAL_PROJECT_ID } from './localProject'
import { deleteMediaBlob, loadMediaBlob, restoreMediaBlob, saveMediaBlob } from './mediaStorage'
import { supabase } from './supabaseClient'
import {
  deleteCachedWaveformPeaks,
  loadCachedWaveformPeaks,
  peaksFromArrayBuffer,
  saveCachedWaveformPeaks,
  useWaveformStore,
} from './waveformStore'

export interface Asset {
  id: string
  project_id: string
  name: string
  file_type: 'video' | 'audio' | 'image'
  file_size: number | null
  duration_seconds: number | null
  playback_url: string
  thumbnail_url: string | null
  local_path?: string | null
  preview_url?: string | null
  created_at: string
  mime_type: string | null
  width: number | null
  height: number | null
  status: 'ready' | 'missing'
}

interface StoredAssetRecord {
  id: string
  project_id: string
  name: string
  file_type: Asset['file_type']
  file_size: number | null
  duration_seconds: number | null
  thumbnail_url: string | null
  created_at: string
  mime_type: string | null
  width: number | null
  height: number | null
  status: 'ready' | 'missing'
  local_path?: string | null
  proxy_path?: string | null
  storage_path?: string | null
  waveform?: number[] | null
  blob?: Blob
}

interface CloudAssetRow {
  id: string
  user_id: string
  project_id: string | null
  name: string
  file_type: string
  file_size: number | null
  duration_seconds: number | null
  storage_url: string
  thumbnail_url: string | null
  created_at: string
}

export interface UploadAssetOptions {
  file: File
  projectId?: string
}

interface AssetStoreState {
  projectId: string | null
  assets: Asset[]
  loading: boolean
  loaded: boolean
  setAssetsForProject: (projectId: string, assets: Asset[]) => void
  upsertAsset: (projectId: string, asset: Asset) => void
  removeAsset: (assetId: string) => void
  updateAssetPreviewUrl: (assetId: string, previewUrl: string) => void
  setLoading: (loading: boolean) => void
  reset: () => void
}

export const useAssetStore = create<AssetStoreState>((set) => ({
  projectId: null,
  assets: [],
  loading: false,
  loaded: false,
  setAssetsForProject: (projectId, assets) =>
    set({ projectId, assets, loading: false, loaded: true }),
  upsertAsset: (projectId, asset) =>
    set((state) => {
      if (state.projectId && state.projectId !== projectId) return state
      const filtered = state.assets.filter((item) => item.id !== asset.id)
      return {
        projectId,
        assets: [asset, ...filtered],
        loaded: true,
      }
    }),
  removeAsset: (assetId) =>
    set((state) => ({
      assets: state.assets.filter((item) => item.id !== assetId),
    })),
  updateAssetPreviewUrl: (assetId, previewUrl) =>
    set((state) => ({
      assets: state.assets.map((item) =>
        item.id === assetId ? { ...item, preview_url: previewUrl } : item
      ),
    })),
  setLoading: (loading) => set({ loading }),
  reset: () => set({ projectId: null, assets: [], loading: false, loaded: false }),
}))

const DB_NAME = 'avi-local-assets'
const DB_VERSION = 1
const STORE_NAME = 'assets'
const STORAGE_BUCKET = 'assets'
const EXPORTED_FILE_NAME_PATTERN = /^avi-export-/i
const THUMBNAIL_TIMEOUT_MS = 10_000

let dbPromise: Promise<IDBDatabase> | null = null

const requestToPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })

const transactionToPromise = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })

const getDatabase = async () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result

        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
          store.createIndex('project_id', 'project_id', { unique: false })
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
    })
  }

  return dbPromise
}

const toAsset = (record: StoredAssetRecord, playbackUrl: string, previewUrl?: string | null): Asset => ({
  id: record.id,
  project_id: record.project_id,
  name: record.name,
  file_type: record.file_type,
  file_size: record.file_size,
  duration_seconds: record.duration_seconds,
  playback_url: playbackUrl,
  thumbnail_url: record.thumbnail_url,
  local_path: record.local_path ?? null,
  preview_url: previewUrl ?? null,
  created_at: record.created_at,
  mime_type: record.mime_type ?? null,
  width: record.width ?? null,
  height: record.height ?? null,
  status: playbackUrl ? 'ready' : 'missing',
})

const createAssetId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

const fileTypeFromName = (name: string): Asset['file_type'] => {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(extension)) return 'video'
  if (['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'].includes(extension)) return 'audio'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image'
  throw new Error('Unsupported file. Choose a video, audio file, or image.')
}

export const detectMediaTypeFromFile = (file: File): Asset['file_type'] | null => {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('image/')) return 'image'
  try {
    return fileTypeFromName(file.name)
  } catch {
    return null
  }
}

const detectFileType = (file: File): Asset['file_type'] => {
  const detected = detectMediaTypeFromFile(file)
  if (!detected) {
    throw new Error('Unsupported file type. Please upload video, audio, or image files.')
  }
  return detected
}

const detectMediaMetadata = (file: File, fileType: Asset['file_type']) =>
  new Promise<{ durationSeconds: number | null; width: number | null; height: number | null }>((resolve) => {
    const TIMEOUT_MS = 15_000
    let settled = false

    const cleanup = () => {
      clearTimeout(timeoutId)
      URL.revokeObjectURL(objectUrl)
    }

    const finish = (value: { durationSeconds: number | null; width: number | null; height: number | null }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const timeoutId = setTimeout(() => {
      finish({ durationSeconds: null, width: null, height: null })
    }, TIMEOUT_MS)

    if (fileType === 'image') {
      const image = new Image()
      const objectUrl = URL.createObjectURL(file)

      image.onload = () => {
        finish({
          durationSeconds: null,
          width: image.naturalWidth || null,
          height: image.naturalHeight || null,
        })
      }

      image.onerror = () => {
        finish({ durationSeconds: null, width: null, height: null })
      }

      image.src = objectUrl
      return
    }

    const media = document.createElement(fileType === 'audio' ? 'audio' : 'video')
    const objectUrl = URL.createObjectURL(file)

    media.preload = 'metadata'
    media.onloadedmetadata = () => {
      const durationSeconds = Number.isFinite(media.duration) ? media.duration : null
      finish({
        durationSeconds,
        width:
          fileType === 'video' && Number.isFinite((media as HTMLVideoElement).videoWidth)
            ? (media as HTMLVideoElement).videoWidth
            : null,
        height:
          fileType === 'video' && Number.isFinite((media as HTMLVideoElement).videoHeight)
            ? (media as HTMLVideoElement).videoHeight
            : null,
      })
    }

    media.onerror = () => {
      finish({ durationSeconds: null, width: null, height: null })
    }

    media.src = objectUrl
  })

const getAssetRecord = async (assetId: string): Promise<StoredAssetRecord | null> => {
  const database = await getDatabase()
  const transaction = database.transaction(STORE_NAME, 'readonly')
  const store = transaction.objectStore(STORE_NAME)
  const record = (await requestToPromise(store.get(assetId))) as StoredAssetRecord | undefined
  await transactionToPromise(transaction)
  return record ?? null
}

const putAssetRecord = async (record: StoredAssetRecord): Promise<void> => {
  const database = await getDatabase()
  const transaction = database.transaction(STORE_NAME, 'readwrite')
  transaction.objectStore(STORE_NAME).put(record)
  await transactionToPromise(transaction)
}

const rememberWaveform = (assetId: string, peaks: number[] | null | undefined) => {
  if (!peaks || peaks.length === 0) return
  useWaveformStore.getState().setPeaks(assetId, peaks)
}

const desktopPlaybackUrl = async (path: string | null | undefined): Promise<string | null> => {
  if (!path || !isDesktopApp()) return null
  try {
    await allowMediaPath(path)
  } catch {
    return null
  }
  return desktopMediaUrl(path)
}

async function getSignedCloudUserId(): Promise<string | null> {
  if (!supabase) return null
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.user?.id ?? null
  } catch {
    return null
  }
}

async function syncAssetToCloud(record: StoredAssetRecord, file?: File): Promise<void> {
  if (!supabase || record.project_id === LOCAL_PROJECT_ID) return

  const userId = await getSignedCloudUserId()
  if (!userId) return

  try {
    let storageUrl = record.storage_path || (record.local_path ? `file://${record.local_path}` : `indexeddb://${record.id}`)
    let uploadedStoragePath: string | null = record.storage_path ?? null

    if (file && !record.local_path) {
      const safeName = record.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const objectPath = `${userId}/${record.project_id}/${record.id}/${safeName}`
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(objectPath, file, { upsert: true, contentType: file.type || undefined })

      if (!uploadError) {
        storageUrl = objectPath
        uploadedStoragePath = objectPath
      }
    }

    const { error } = await supabase.from('assets').upsert(
      {
        id: record.id,
        user_id: userId,
        project_id: record.project_id,
        name: record.name,
        file_type: record.file_type,
        file_size: record.file_size,
        duration_seconds: record.duration_seconds,
        storage_url: storageUrl,
        thumbnail_url: record.thumbnail_url,
      },
      { onConflict: 'id' }
    )

    if (error) {
      console.warn('Cloud asset metadata sync skipped:', error.message)
      return
    }

    if (uploadedStoragePath && uploadedStoragePath !== record.storage_path) {
      await putAssetRecord({ ...record, storage_path: uploadedStoragePath })
    }
  } catch (error) {
    console.warn('Cloud asset sync unavailable:', error)
  }
}

async function deleteCloudAssetRecord(assetId: string, storagePath?: string | null): Promise<void> {
  if (!supabase) return
  const userId = await getSignedCloudUserId()
  if (!userId) return

  try {
    if (storagePath && !storagePath.startsWith('indexeddb://') && !storagePath.startsWith('file://')) {
      await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => undefined)
    }
    await supabase.from('assets').delete().eq('id', assetId)
  } catch (error) {
    console.warn('Cloud asset deletion skipped:', error)
  }
}

const resolveAssetPlaybackUrl = async (record: StoredAssetRecord): Promise<string | null> => {
  const localPlaybackUrl = await desktopPlaybackUrl(record.local_path)
  if (localPlaybackUrl) {
    rememberWaveform(record.id, record.waveform)
    return localPlaybackUrl
  }

  const indexedPlaybackUrl = await loadMediaBlob(record.id)
  if (indexedPlaybackUrl) {
    rememberWaveform(record.id, record.waveform)
    return indexedPlaybackUrl
  }

  if (record.storage_path && supabase && !record.storage_path.startsWith('indexeddb://') && !record.storage_path.startsWith('file://')) {
    try {
      const { data } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(record.storage_path, 3600)
      if (data?.signedUrl) {
        rememberWaveform(record.id, record.waveform)
        return data.signedUrl
      }
    } catch {
      // Fall through to legacy blob check or missing status
    }
  }

  if (!(record.blob instanceof Blob)) {
    return null
  }

  const playbackUrl = await restoreMediaBlob(record.id, record.blob)
  const { blob: _legacyBlob, ...metadataRecord } = record
  await putAssetRecord({
    ...metadataRecord,
    mime_type: metadataRecord.mime_type ?? null,
    width: metadataRecord.width ?? null,
    height: metadataRecord.height ?? null,
    status: 'ready',
  })
  return playbackUrl
}

export async function uploadAsset({
  file,
  projectId,
}: UploadAssetOptions): Promise<Asset> {
  if (!projectId) {
    throw new Error('Project must be initialized before uploading assets')
  }

  if (EXPORTED_FILE_NAME_PATTERN.test(file.name)) {
    throw new Error('Exported files are excluded from source assets. Rename the file before importing.')
  }

  const fileType = detectFileType(file)

  const [{ durationSeconds, width, height }, thumbnailUrl] = await Promise.all([
    detectMediaMetadata(file, fileType),
    fileType === 'video' ? generateVideoThumbnail(file) : Promise.resolve(null),
  ])

  const assetId = createAssetId()
  const playbackUrl = await saveMediaBlob(assetId, file)

  const record: StoredAssetRecord = {
    id: assetId,
    project_id: projectId,
    name: file.name,
    file_type: fileType,
    file_size: file.size,
    duration_seconds: durationSeconds,
    thumbnail_url: thumbnailUrl,
    created_at: new Date().toISOString(),
    mime_type: file.type || null,
    width,
    height,
    status: 'ready',
  }

  try {
    await putAssetRecord(record)
  } catch (error) {
    await deleteMediaBlob(assetId)
    throw error
  }

  const asset = toAsset(record, playbackUrl)
  useAssetStore.getState().upsertAsset(projectId, asset)
  void captureWaveform(asset, file)
  void syncAssetToCloud(record, file)
  return asset
}

async function fetchCloudAssetsForProject(projectId: string): Promise<CloudAssetRow[]> {
  if (!supabase || projectId === LOCAL_PROJECT_ID) return []
  const userId = await getSignedCloudUserId()
  if (!userId) return []

  try {
    const { data, error } = await supabase
      .from('assets')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (error || !Array.isArray(data)) return []
    return data as CloudAssetRow[]
  } catch {
    return []
  }
}

export async function getProjectAssets(projectId: string): Promise<Asset[]> {
  const database = await getDatabase()
  const transaction = database.transaction(STORE_NAME, 'readonly')
  const index = transaction.objectStore(STORE_NAME).index('project_id')
  const records = (await requestToPromise(index.getAll(projectId))) as StoredAssetRecord[] | undefined
  await transactionToPromise(transaction)

  const localRecords = records ?? []
  const localIds = new Set(localRecords.map((r) => r.id))

  const localAssets = await Promise.all(
    localRecords.map(async (record) => {
      if (record.waveform && record.waveform.length > 0) {
        useWaveformStore.getState().setPeaks(record.id, record.waveform)
      } else {
        void loadCachedWaveformPeaks(record.id)
      }
      const playbackUrl = await resolveAssetPlaybackUrl(record)
      const previewUrl = await desktopPlaybackUrl(record.proxy_path)
      return toAsset(record, playbackUrl ?? '', previewUrl)
    })
  )

  const cloudRows = await fetchCloudAssetsForProject(projectId)
  const remoteOnlyAssets = await Promise.all(
    cloudRows
      .filter((row) => !localIds.has(row.id))
      .map(async (row): Promise<Asset> => {
        let playbackUrl = ''
        if (
          supabase &&
          row.storage_url &&
          !row.storage_url.startsWith('indexeddb://') &&
          !row.storage_url.startsWith('file://')
        ) {
          try {
            const { data } = await supabase.storage
              .from(STORAGE_BUCKET)
              .createSignedUrl(row.storage_url, 3600)
            playbackUrl = data?.signedUrl ?? ''
          } catch {
            playbackUrl = ''
          }
        }
        const fileType: Asset['file_type'] =
          row.file_type === 'audio' || row.file_type === 'image' ? row.file_type : 'video'
        return {
          id: row.id,
          project_id: row.project_id ?? projectId,
          name: row.name,
          file_type: fileType,
          file_size: row.file_size,
          duration_seconds: row.duration_seconds,
          playback_url: playbackUrl,
          thumbnail_url: row.thumbnail_url,
          local_path: null,
          preview_url: null,
          created_at: row.created_at,
          mime_type: null,
          width: null,
          height: null,
          status: playbackUrl ? 'ready' : 'missing',
        }
      })
  )

  const merged = [...localAssets, ...remoteOnlyAssets].sort((left, right) =>
    right.created_at.localeCompare(left.created_at)
  )

  useAssetStore.getState().setAssetsForProject(projectId, merged)
  return merged
}

export async function ensureProjectAssets(projectId: string): Promise<Asset[]> {
  const state = useAssetStore.getState()
  if (state.loaded && state.projectId === projectId) {
    return state.assets
  }
  return getProjectAssets(projectId)
}

export async function loadProjectAssetsIntoStore(projectId: string): Promise<Asset[]> {
  useAssetStore.getState().setLoading(true)
  try {
    return await getProjectAssets(projectId)
  } finally {
    useAssetStore.getState().setLoading(false)
  }
}

export async function migrateProjectAssets(fromProjectId: string, toProjectId: string): Promise<void> {
  if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) return

  const database = await getDatabase()
  const transaction = database.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  const index = store.index('project_id')
  const records = (await requestToPromise(index.getAll(fromProjectId))) as StoredAssetRecord[] | undefined

  const migratedRecords: StoredAssetRecord[] = []
  for (const record of records ?? []) {
    const updated: StoredAssetRecord = { ...record, project_id: toProjectId }
    store.put(updated)
    migratedRecords.push(updated)
  }
  await transactionToPromise(transaction)

  if (migratedRecords.length > 0) {
    for (const record of migratedRecords) {
      void syncAssetToCloud(record)
    }
    await loadProjectAssetsIntoStore(toProjectId)
    window.dispatchEvent(new Event('avi:assets-changed'))
  }
}

export async function deleteAsset(assetId: string): Promise<void> {
  const existing = await getAssetRecord(assetId)
  await deleteMediaBlob(assetId)
  await deleteCachedWaveformPeaks(assetId)
  await deletePlaybackProxy(assetId).catch(() => undefined)

  const database = await getDatabase()
  const transaction = database.transaction(STORE_NAME, 'readwrite')
  transaction.objectStore(STORE_NAME).delete(assetId)
  await transactionToPromise(transaction)

  useAssetStore.getState().removeAsset(assetId)
  await deleteCloudAssetRecord(assetId, existing?.storage_path)
}

export async function deleteProjectAssets(projectId: string): Promise<void> {
  const database = await getDatabase()
  const transaction = database.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  const index = store.index('project_id')
  const records = (await requestToPromise(index.getAll(projectId))) as StoredAssetRecord[] | undefined

  for (const record of records ?? []) {
    store.delete(record.id)
  }

  await transactionToPromise(transaction)
  await Promise.all(
    (records ?? []).map(async (record) => {
      await deleteMediaBlob(record.id)
      await deleteCachedWaveformPeaks(record.id)
      await deletePlaybackProxy(record.id).catch(() => undefined)
      await deleteCloudAssetRecord(record.id, record.storage_path)
    })
  )

  if (useAssetStore.getState().projectId === projectId) {
    useAssetStore.getState().reset()
  }
}

export async function resolveTracksWithAssets(tracks: Track[], fps: number): Promise<Track[]> {
  const assetIds = Array.from(
    new Set(
      tracks.flatMap((track) => track.clips.map((clip) => clip.assetId).filter(Boolean)) as string[]
    )
  )

  const assetPayloads = await Promise.all(
    assetIds.map(async (assetId) => {
      const record = await getAssetRecord(assetId)
      const playbackUrl = record
        ? await resolveAssetPlaybackUrl(record)
        : await loadMediaBlob(assetId)

      return {
        assetId,
        record,
        playbackUrl,
        previewUrl: record ? await desktopPlaybackUrl(record.proxy_path) : null,
      }
    })
  )

  const recordMap = new Map(
    assetPayloads
      .map((entry) => entry.record)
      .filter((record): record is StoredAssetRecord => Boolean(record))
      .map((record) => [record.id, record])
  )
  const playbackUrlMap = new Map(
    assetPayloads
      .filter((entry): entry is { assetId: string; record: StoredAssetRecord | null; playbackUrl: string; previewUrl: string | null } => Boolean(entry.playbackUrl))
      .map((entry) => [entry.assetId, entry.playbackUrl])
  )
  const previewUrlMap = new Map(
    assetPayloads
      .filter((entry) => Boolean(entry.previewUrl))
      .map((entry) => [entry.assetId, entry.previewUrl as string])
  )

  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (!clip.assetId) return { ...clip }

      const record = recordMap.get(clip.assetId)
      const playbackUrl = record ? playbackUrlMap.get(clip.assetId) : undefined
      if (!playbackUrl) {
        return {
          ...clip,
          assetUrl: undefined,
          isMissingAsset: true,
        }
      }

      const mediaDurationFrames =
        clip.mediaDurationFrames ??
        (record?.duration_seconds != null ? Math.max(1, Math.round(record.duration_seconds * fps)) : undefined)

      return {
        ...clip,
        assetUrl: playbackUrl,
        previewUrl: previewUrlMap.get(clip.assetId),
        isMissingAsset: false,
        mediaDurationFrames,
      }
    }),
  }))
}

function captureVideoThumbnail(src: string, revokeOnDone: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true

    let settled = false
    const cleanup = () => {
      clearTimeout(timeoutId)
      video.removeEventListener('loadeddata', onLoadedData)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      video.removeAttribute('src')
      if (revokeOnDone && src.startsWith('blob:')) {
        URL.revokeObjectURL(src)
      }
    }

    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const captureFrame = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 180
        const context = canvas.getContext('2d')
        if (!context) {
          finish(null)
          return
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        finish(canvas.toDataURL('image/jpeg', 0.8))
      } catch {
        finish(null)
      }
    }

    const onLoadedData = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
      const targetTime = duration > 0 ? Math.min(1, duration / 2) : 0
      if (targetTime === 0 && video.readyState >= 2) {
        captureFrame()
        return
      }
      try {
        video.currentTime = targetTime
      } catch {
        if (video.readyState >= 2) {
          captureFrame()
        } else {
          finish(null)
        }
      }
    }

    const onSeeked = () => captureFrame()
    const onError = () => finish(null)

    const timeoutId = setTimeout(() => finish(null), THUMBNAIL_TIMEOUT_MS)

    video.addEventListener('loadeddata', onLoadedData)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.src = src
  })
}

export async function generateVideoThumbnail(file: File): Promise<string | null> {
  const objectUrl = URL.createObjectURL(file)
  return captureVideoThumbnail(objectUrl, true)
}

const metadataFromSrc = (src: string, fileType: Asset['file_type']) =>
  new Promise<{ durationSeconds: number | null; width: number | null; height: number | null }>((resolve) => {
    let settled = false
    const finish = (value: { durationSeconds: number | null; width: number | null; height: number | null }) => {
      if (settled) return
      settled = true
      if (src.startsWith('blob:')) URL.revokeObjectURL(src)
      resolve(value)
    }
    const timeoutId = window.setTimeout(() => {
      finish({ durationSeconds: null, width: null, height: null })
    }, 15_000)

    const done = (value: { durationSeconds: number | null; width: number | null; height: number | null }) => {
      window.clearTimeout(timeoutId)
      finish(value)
    }

    if (fileType === 'image') {
      const image = new Image()
      image.onload = () => done({ durationSeconds: null, width: image.naturalWidth || null, height: image.naturalHeight || null })
      image.onerror = () => done({ durationSeconds: null, width: null, height: null })
      image.src = src
      return
    }

    const media = document.createElement(fileType === 'audio' ? 'audio' : 'video')
    media.preload = 'metadata'
    media.onloadedmetadata = () => {
      const video = media as HTMLVideoElement
      done({
        durationSeconds: Number.isFinite(media.duration) ? media.duration : null,
        width: fileType === 'video' && Number.isFinite(video.videoWidth) ? video.videoWidth : null,
        height: fileType === 'video' && Number.isFinite(video.videoHeight) ? video.videoHeight : null,
      })
    }
    media.onerror = () => done({ durationSeconds: null, width: null, height: null })
    media.src = src
  })

const thumbnailFromSrc = (src: string) => captureVideoThumbnail(src, false)

const WAVEFORM_BYTE_LIMIT = 40 * 1024 * 1024

export async function captureWaveform(asset: Asset, file?: File): Promise<void> {
  if (asset.file_type === 'image') return

  try {
    const cached = await loadCachedWaveformPeaks(asset.id)
    if (cached && cached.length > 0) return

    let bytes: ArrayBuffer | null = null
    if (file && file.size <= WAVEFORM_BYTE_LIMIT) {
      bytes = await file.arrayBuffer()
    } else if (
      asset.playback_url &&
      asset.file_size != null &&
      asset.file_size > 0 &&
      asset.file_size <= WAVEFORM_BYTE_LIMIT
    ) {
      const response = await fetch(asset.playback_url)
      if (!response.ok) return
      bytes = await response.arrayBuffer()
    }

    if (!bytes) return
    const peaks = await peaksFromArrayBuffer(bytes)
    if (!peaks) return

    await saveCachedWaveformPeaks(asset.id, peaks)
    const record = await getAssetRecord(asset.id)
    if (record) {
      await putAssetRecord({ ...record, waveform: peaks })
    }
  } catch {
    // A missing waveform still leaves the clip editable.
  }
}

export async function importLocalPath(path: string, projectId: string): Promise<Asset> {
  const name = path.split(/[/\\]/).pop() || 'media'
  if (EXPORTED_FILE_NAME_PATTERN.test(name)) {
    throw new Error('Exported files are excluded from source assets. Rename the file before importing.')
  }

  const fileType = fileTypeFromName(name)
  await allowMediaPath(path)
  const playbackUrl = await desktopMediaUrl(path)
  const [{ durationSeconds, width, height }, thumbnailUrl, fileSize] = await Promise.all([
    metadataFromSrc(playbackUrl, fileType),
    fileType === 'video' ? thumbnailFromSrc(playbackUrl) : Promise.resolve(null),
    localFileSize(path),
  ])

  const record: StoredAssetRecord = {
    id: createAssetId(),
    project_id: projectId,
    name,
    file_type: fileType,
    file_size: fileSize,
    duration_seconds: durationSeconds,
    thumbnail_url: thumbnailUrl,
    created_at: new Date().toISOString(),
    mime_type: null,
    width,
    height,
    status: 'ready',
    local_path: path,
  }

  await putAssetRecord(record)
  const asset = toAsset(record, playbackUrl)
  useAssetStore.getState().upsertAsset(projectId, asset)
  void captureWaveform(asset)
  void syncAssetToCloud(record)
  return asset
}

export async function importMediaPaths(paths: string[], projectId: string): Promise<Asset[]> {
  const imported: Asset[] = []
  for (const path of paths) {
    if (!isSupportedMediaPath(path)) continue
    const asset = await importLocalPath(path, projectId)
    imported.push(asset)
    void schedulePlaybackProxy(asset).catch(() => undefined)
  }

  if (imported.length > 0) {
    window.dispatchEvent(new Event('avi:assets-changed'))
  }

  return imported
}

export async function schedulePlaybackProxy(asset: Asset): Promise<void> {
  if (!isDesktopApp() || asset.file_type !== 'video' || !asset.local_path) return
  if (!(await ffmpegAvailable())) return

  const proxyPath = await generatePlaybackProxy(asset.local_path, asset.id)
  const record = await getAssetRecord(asset.id)
  if (!record) return

  await putAssetRecord({ ...record, proxy_path: proxyPath })
  const previewUrl = await desktopMediaUrl(proxyPath)
  useEditorStore.getState().setAssetPreviewUrl(asset.id, previewUrl)
  useAssetStore.getState().updateAssetPreviewUrl(asset.id, previewUrl)
}
