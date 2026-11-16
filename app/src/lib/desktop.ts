import { invoke } from '@tauri-apps/api/core'

export const isDesktopApp = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv', 'm4v']
const MEDIA_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  'mp3',
  'wav',
  'aac',
  'm4a',
  'flac',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
]

export async function pickMediaPaths(videosOnly: boolean): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: true,
    title: videosOnly ? 'Open video' : 'Import media',
    filters: [
      {
        name: videosOnly ? 'Video' : 'Media',
        extensions: videosOnly ? VIDEO_EXTENSIONS : MEDIA_EXTENSIONS,
      },
    ],
  })

  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

export async function allowMediaPath(path: string): Promise<void> {
  await invoke('allow_media_path', { path })
}

let mediaBase: Promise<string> | null = null
let mediaSessionToken: Promise<string> | null = null

function mediaBaseUrl(): Promise<string> {
  if (!mediaBase) {
    mediaBase = invoke<string>('media_base_url').catch((error: unknown) => {
      mediaBase = null
      throw error
    })
  }
  return mediaBase
}

function mediaToken(): Promise<string> {
  if (!mediaSessionToken) {
    mediaSessionToken = invoke<string>('media_token').catch((error: unknown) => {
      mediaSessionToken = null
      throw error
    })
  }
  return mediaSessionToken
}

// WebKitGTK cannot play asset:// URLs in a video element. The shell serves
// allowed files from 127.0.0.1 with a per-launch token instead. Call allowMediaPath before this.
export async function desktopMediaUrl(path: string): Promise<string> {
  const [base, token] = await Promise.all([mediaBaseUrl(), mediaToken()])
  return `${base}/media?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`
}

export function extractLocalPathFromDesktopMediaUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/media') {
      return null
    }
    return parsed.searchParams.get('path')
  } catch {
    return null
  }
}

export function isSupportedMediaPath(path: string, videosOnly = false): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return (videosOnly ? VIDEO_EXTENSIONS : MEDIA_EXTENSIONS).includes(extension)
}

export async function localFileSize(path: string): Promise<number | null> {
  try {
    const info = await invoke<{ size: number }>('local_file_info', { path })
    return Number.isFinite(info.size) ? info.size : null
  } catch {
    return null
  }
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    const tools = await invoke<{ ffmpeg: boolean }>('media_tools')
    return tools.ffmpeg
  } catch {
    return false
  }
}

export async function generatePlaybackProxy(source: string, assetId: string): Promise<string> {
  return invoke<string>('generate_proxy', { source, assetId })
}

export async function deletePlaybackProxy(assetId: string): Promise<void> {
  if (!isDesktopApp()) return
  await invoke('delete_proxy', { assetId })
}

export async function pickExportPath(defaultFilename: string): Promise<string | null> {
  return invoke<string | null>('pick_export_path', { defaultFilename })
}

export async function writeExportBytes(path: string, bytes: Uint8Array): Promise<void> {
  await invoke('write_export_bytes', { path, bytes: Array.from(bytes) })
}

export interface NativeExportClipInput {
  id: string
  trackType: 'video' | 'audio' | 'overlay'
  trackMuted: boolean
  startFrame: number
  endFrame: number
  mediaType: 'video' | 'audio' | 'image' | 'text'
  sourcePath?: string
  mediaStart?: number
  mediaEnd?: number
  opacity?: number
  pixelFilter?: string
  text?: string
  fontSize?: number
  fontColor?: string
}

export interface NativeExportTimelineRequest {
  outputPath: string
  width: number
  height: number
  fps: number
  totalFrames: number
  clips: NativeExportClipInput[]
}

export async function exportTimelineNative(request: NativeExportTimelineRequest): Promise<string> {
  return invoke<string>('export_timeline', { request })
}

export async function startOAuthLoopback(): Promise<string> {
  return invoke<string>('start_oauth_loopback')
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_external_url', { url })
}

export async function saveExportFile(filename: string, blob: Blob): Promise<'saved' | 'downloaded' | 'cancelled'> {
  if (!isDesktopApp()) {
    downloadBlob(filename, blob)
    return 'downloaded'
  }

  const path = await pickExportPath(filename)
  if (!path) return 'cancelled'

  await writeExportBytes(path, new Uint8Array(await blob.arrayBuffer()))
  return 'saved'
}

function downloadBlob(filename: string, blob: Blob) {
  const downloadUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = downloadUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
}
