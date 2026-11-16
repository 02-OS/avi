import { hasMissingRenderableMedia, hasUsableVideoClips, sortTracksForRender } from './editorUtils'
import { applyPixelFilterInPlace } from './pixelFilter'
import { type Clip, type Track } from '../store/useEditorStore'

export const EXPORT_PRESETS = {
  '720p': { width: 1280, height: 720, videoBitsPerSecond: 5_000_000 },
  '1080p': { width: 1920, height: 1080, videoBitsPerSecond: 8_000_000 },
} as const

export type ExportPresetName = keyof typeof EXPORT_PRESETS

interface ExportVideoOptions {
  tracks: Track[]
  fps: number
  totalFrames: number
  preset?: ExportPresetName
  onProgress?: (progress: number) => void
}

interface ExportResult {
  blob: Blob
  filename: string
  mimeType: string
}

type MediaResource =
  | {
      kind: 'image'
      clip: Clip
      image: HTMLImageElement
    }
  | {
      kind: 'video'
      clip: Clip
      trackMuted: boolean
      element: HTMLVideoElement
      source: MediaElementAudioSourceNode | null
    }
  | {
      kind: 'audio'
      clip: Clip
      trackMuted: boolean
      element: HTMLAudioElement
      source: MediaElementAudioSourceNode | null
    }
  | {
      kind: 'text'
      clip: Clip
    }

const getSupportedMimeType = () => {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? null
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)
    ),
  ])

const waitForImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load image asset: ${src}`))
    image.src = src
  })

const waitForMediaReady = (element: HTMLMediaElement) =>
  new Promise<void>((resolve, reject) => {
    if (element.readyState >= 2) {
      resolve()
      return
    }

    const handleReady = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error(`Failed to load media element: ${element.currentSrc || element.src}`))
    }
    const cleanup = () => {
      element.removeEventListener('loadeddata', handleReady)
      element.removeEventListener('canplay', handleReady)
      element.removeEventListener('error', handleError)
    }

    element.addEventListener('loadeddata', handleReady)
    element.addEventListener('canplay', handleReady)
    element.addEventListener('error', handleError)
  })

const seekMediaElement = (element: HTMLMediaElement, desiredTime: number, timeoutMs = 2000) =>
  new Promise<void>((resolve) => {
    const finiteDuration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : desiredTime
    const clampedTime = clamp(desiredTime, 0, Math.max(0, finiteDuration))

    if (
      Number.isFinite(element.currentTime) &&
      Math.abs(element.currentTime - clampedTime) < 0.002 &&
      element.readyState >= 2
    ) {
      resolve()
      return
    }

    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      element.removeEventListener('seeked', onSeeked)
      element.removeEventListener('error', onDone)
    }
    const onDone = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onSeeked = () => onDone()
    const timer = setTimeout(onDone, timeoutMs)

    element.addEventListener('seeked', onSeeked)
    element.addEventListener('error', onDone)
    try {
      element.currentTime = clampedTime
    } catch {
      onDone()
    }
  })

const loadMediaResources = async (
  tracks: Track[],
  audioContext: AudioContext,
  destination: MediaStreamAudioDestinationNode
) => {
  const orderedTracks = sortTracksForRender(tracks)
  const resources = await Promise.all(
    orderedTracks.flatMap((track) => {
      const trackMuted = Boolean(track.muted)
      return track.clips.map(async (clip): Promise<MediaResource | null> => {
        if (clip.mediaType === 'text' && clip.text) {
          return { kind: 'text', clip }
        }

        if (!clip.assetUrl || clip.isMissingAsset) {
          return null
        }

        if (clip.mediaType === 'image') {
          const image = await withTimeout(waitForImage(clip.assetUrl), 8000, clip.label)
          return { kind: 'image', clip, image }
        }

        if (clip.mediaType === 'video') {
          const element = document.createElement('video')
          element.crossOrigin = 'anonymous'
          element.src = clip.assetUrl
          element.preload = 'auto'
          element.muted = trackMuted
          element.playsInline = true

          await withTimeout(waitForMediaReady(element), 8000, clip.label)

          let source: MediaElementAudioSourceNode | null = null
          if (!trackMuted) {
            try {
              source = audioContext.createMediaElementSource(element)
              source.connect(destination)
            } catch {
              source = null
            }
          }

          return { kind: 'video', clip, trackMuted, element, source }
        }

        if (clip.mediaType === 'audio') {
          if (trackMuted) return null
          const element = document.createElement('audio')
          element.crossOrigin = 'anonymous'
          element.src = clip.assetUrl
          element.preload = 'auto'
          element.muted = false

          await withTimeout(waitForMediaReady(element), 8000, clip.label)

          let source: MediaElementAudioSourceNode | null = null
          try {
            source = audioContext.createMediaElementSource(element)
            source.connect(destination)
          } catch {
            source = null
          }

          return { kind: 'audio', clip, trackMuted, element, source }
        }

        return null
      })
    })
  )

  return resources.filter((resource): resource is MediaResource => Boolean(resource))
}

const drawCover = (
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number
) => {
  const intrinsicWidth =
    'videoWidth' in source
      ? source.videoWidth
      : 'naturalWidth' in source
        ? source.naturalWidth
        : width
  const intrinsicHeight =
    'videoHeight' in source
      ? source.videoHeight
      : 'naturalHeight' in source
        ? source.naturalHeight
        : height

  if (!intrinsicWidth || !intrinsicHeight || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    return
  }

  const scale = Math.max(width / intrinsicWidth, height / intrinsicHeight)
  const drawWidth = intrinsicWidth * scale
  const drawHeight = intrinsicHeight * scale
  const x = (width - drawWidth) / 2
  const y = (height - drawHeight) / 2
  context.drawImage(source, x, y, drawWidth, drawHeight)
}

const drawTextClip = (context: CanvasRenderingContext2D, clip: Clip, width: number, height: number) => {
  const scaleFactor = height / 720
  const scaledFontSize = Math.max(12, Math.round((clip.fontSize || 48) * scaleFactor))
  const horizontalMargin = Math.round(120 * (width / 1280))

  context.save()
  context.fillStyle = clip.fontColor || '#ffffff'
  context.font = `800 ${scaledFontSize}px system-ui`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.shadowColor = 'rgba(0,0,0,0.55)'
  context.shadowBlur = Math.round(24 * scaleFactor)
  context.fillText(clip.text || '', width / 2, height / 2, Math.max(100, width - horizontalMargin))
  context.restore()
}

const paintFilteredSource = async (
  context: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  scratchCanvas: HTMLCanvasElement,
  source: CanvasImageSource,
  clip: Clip,
  width: number,
  height: number
) => {
  scratch.clearRect(0, 0, width, height)
  drawCover(scratch, source, width, height)

  if (clip.pixelFilter) {
    try {
      const image = scratch.getImageData(0, 0, width, height)
      await applyPixelFilterInPlace(image.data, clip.pixelFilter)
      scratch.putImageData(image, 0, 0)
    } catch (error) {
      console.warn('Pixel filter skipped for an export frame', error)
    }
  }

  context.drawImage(scratchCanvas, 0, 0)
}

const getClipFrameOffset = (clip: Clip, elapsedFrames: number) => {
  const mediaStart = clip.mediaStart ?? 0
  return mediaStart + (elapsedFrames - clip.startFrame)
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function exportEditedVideo({
  tracks,
  fps,
  totalFrames,
  preset = '720p',
  onProgress,
}: ExportVideoOptions): Promise<ExportResult> {
  const { width, height, videoBitsPerSecond } = EXPORT_PRESETS[preset]
  if (!hasUsableVideoClips(tracks)) {
    throw new Error('Upload a video to the timeline before exporting')
  }

  if (hasMissingRenderableMedia(tracks)) {
    throw new Error('Export is blocked because some media files are missing from local storage')
  }

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support video export')
  }

  const mimeType = getSupportedMimeType()
  if (!mimeType) {
    throw new Error('This browser does not support WebM recording for export')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  const scratchCanvas = document.createElement('canvas')
  scratchCanvas.width = width
  scratchCanvas.height = height
  const scratch = scratchCanvas.getContext('2d', { willReadFrequently: true })
  if (!context || !scratch) {
    throw new Error('Failed to create an export canvas')
  }

  let audioContext: AudioContext | null = null
  let destination: MediaStreamAudioDestinationNode | null = null
  let resources: MediaResource[] = []
  let canvasStream: MediaStream | null = null
  let exportStream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let stopPromise: Promise<Blob> | null = null

  let blob: Blob

  try {
    audioContext = new AudioContext()
    await audioContext.resume()
    destination = audioContext.createMediaStreamDestination()
    resources = await loadMediaResources(tracks, audioContext, destination)

    // Capture manually when requestFrame is available so every stepped frame is emitted cleanly.
    const probeTrack = canvas.captureStream(0).getVideoTracks()[0]
    const supportsManualRequestFrame =
      Boolean(probeTrack) && 'requestFrame' in probeTrack && typeof (probeTrack as { requestFrame?: unknown }).requestFrame === 'function'
    probeTrack?.stop()

    canvasStream = supportsManualRequestFrame ? canvas.captureStream(0) : canvas.captureStream(fps)
    const videoCaptureTrack = canvasStream.getVideoTracks()[0] as
      | (MediaStreamTrack & { requestFrame?: () => void })
      | undefined

    exportStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ])

    const chunks: BlobPart[] = []
    recorder = new MediaRecorder(exportStream, {
      mimeType,
      videoBitsPerSecond,
    })

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    }

    stopPromise = new Promise<Blob>((resolve, reject) => {
      recorder!.onerror = () => reject(new Error('Export recording failed'))
      recorder!.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
    })

    const resourceState = new Map<HTMLMediaElement, boolean>()
    const safeTotalFrames = Math.max(1, Math.floor(totalFrames))
    const safeFps = Math.max(1, fps)
    const frameIntervalMs = 1000 / safeFps

    recorder.start(250)
    const exportStartMs = performance.now()

    const syncMedia = async (
      resource: Extract<MediaResource, { element: HTMLMediaElement }>,
      frameIndex: number
    ) => {
      const { clip, element } = resource
      const isActive = frameIndex >= clip.startFrame && frameIndex <= clip.endFrame
      const wasActive = resourceState.get(element) ?? false

      if (!isActive) {
        if (wasActive && !element.paused) {
          element.pause()
        }
        resourceState.set(element, false)
        return
      }

      const desiredTime = getClipFrameOffset(clip, frameIndex) / safeFps

      if (!wasActive) {
        await seekMediaElement(element, desiredTime)
        try {
          await element.play()
        } catch {
          // Audio playback may be blocked in headless contexts; visual stepping continues via seek.
        }
      } else if (
        element.paused ||
        !Number.isFinite(element.currentTime) ||
        Math.abs(element.currentTime - desiredTime) > Math.max(0.08, frameIntervalMs / 1000 * 1.5)
      ) {
        await seekMediaElement(element, desiredTime)
      }

      resourceState.set(element, true)
    }

    for (let frameIndex = 0; frameIndex < safeTotalFrames; frameIndex += 1) {
      context.clearRect(0, 0, width, height)
      context.fillStyle = '#0e0e0e'
      context.fillRect(0, 0, width, height)

      for (const resource of resources) {
        if ('element' in resource) {
          await syncMedia(resource, frameIndex)
        }

        const isActive =
          frameIndex >= resource.clip.startFrame && frameIndex <= resource.clip.endFrame
        if (!isActive) continue

        context.save()
        context.globalAlpha = resource.clip.opacity ?? 1

        if (resource.kind === 'image') {
          await paintFilteredSource(
            context,
            scratch,
            scratchCanvas,
            resource.image,
            resource.clip,
            width,
            height
          )
        }

        if (resource.kind === 'video' && resource.element.readyState >= 2) {
          await paintFilteredSource(
            context,
            scratch,
            scratchCanvas,
            resource.element,
            resource.clip,
            width,
            height
          )
        }

        if (resource.kind === 'text') {
          drawTextClip(context, resource.clip, width, height)
        }

        context.restore()
      }

      videoCaptureTrack?.requestFrame?.()
      onProgress?.(Math.min(100, Math.round(((frameIndex + 1) / safeTotalFrames) * 100)))

      const targetNextFrameMs = exportStartMs + (frameIndex + 1) * frameIntervalMs
      const remainingMs = Math.max(0, targetNextFrameMs - performance.now())
      await sleepMs(remainingMs)
    }

    recorder.stop()
    blob = await stopPromise
  } catch (error) {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }

    if (stopPromise) {
      try {
        await stopPromise
      } catch {
        // Ignore recorder shutdown errors and preserve the original failure.
      }
    }

    throw error
  } finally {
    resources.forEach((resource) => {
      if ('element' in resource) {
        resource.element.pause()
        resource.element.removeAttribute('src')
        resource.element.load()
      }
    })

    exportStream?.getTracks().forEach((track) => track.stop())
    canvasStream?.getTracks().forEach((track) => track.stop())
    destination?.stream.getTracks().forEach((track) => track.stop())

    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close()
    }
  }

  const now = new Date()
  const filename = `avi-export-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.webm`

  return {
    blob,
    filename,
    mimeType,
  }
}
