import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AbsoluteFill, Html5Audio, Img, Html5Video, Sequence, interpolate, useCurrentFrame } from 'remotion'
import { type Clip, type Track, useEditorStore } from '../../store/useEditorStore'
import { getSafeMediaTrimProps, validateClip } from '../../lib/clipValidation'
import { sortTracksForRender } from '../../lib/editorUtils'
import { applyPixelFilterInPlace, cssFilterFor, type PixelFilterName } from '../../lib/pixelFilter'

const playbackSrc = (clip: Clip) => clip.previewUrl || clip.assetUrl || ''

const PAUSED_GRADE_WIDTH = 640
const PAUSED_GRADE_HEIGHT = 360
const MAX_GRADED_FRAME_CACHE = 32
const gradedFrameCache = new Map<string, ImageData>()

function rememberGradedFrame(key: string, imageData: ImageData): void {
  if (gradedFrameCache.has(key)) {
    gradedFrameCache.delete(key)
  } else if (gradedFrameCache.size >= MAX_GRADED_FRAME_CACHE) {
    const oldestKey = gradedFrameCache.keys().next().value
    if (oldestKey !== undefined) {
      gradedFrameCache.delete(oldestKey)
    }
  }
  gradedFrameCache.set(key, imageData)
}

function drawCoverCrop(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  targetWidth: number,
  targetHeight: number
): boolean {
  const intrinsicWidth =
    'videoWidth' in source
      ? source.videoWidth
      : 'naturalWidth' in source
        ? source.naturalWidth
        : targetWidth
  const intrinsicHeight =
    'videoHeight' in source
      ? source.videoHeight
      : 'naturalHeight' in source
        ? source.naturalHeight
        : targetHeight

  if (!intrinsicWidth || !intrinsicHeight || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    return false
  }

  const scale = Math.max(targetWidth / intrinsicWidth, targetHeight / intrinsicHeight)
  const drawWidth = intrinsicWidth * scale
  const drawHeight = intrinsicHeight * scale
  const x = (targetWidth - drawWidth) / 2
  const y = (targetHeight - drawHeight) / 2
  context.clearRect(0, 0, targetWidth, targetHeight)
  context.drawImage(source, x, y, drawWidth, drawHeight)
  return true
}

const PausedWasmGrade: React.FC<{ clip: Clip; src: string; filter: PixelFilterName }> = ({ clip, src, filter }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [mediaRevision, setMediaRevision] = useState(0)
  const [ready, setReady] = useState(false)
  const frame = useCurrentFrame()
  const fps = useEditorStore((state) => state.fps)
  const isPlaying = useEditorStore((state) => state.isPlaying)

  // Lifecycle effect: create and clean up media elements only when src or mediaType changes.
  useEffect(() => {
    videoRef.current = null
    imageRef.current = null
    setReady(false)

    if (!src) return

    if (clip.mediaType === 'image') {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      const onLoad = () => {
        imageRef.current = image
        setMediaRevision((rev) => rev + 1)
      }
      const onError = () => {
        imageRef.current = null
        setReady(false)
      }
      image.addEventListener('load', onLoad)
      image.addEventListener('error', onError)
      image.src = src

      return () => {
        image.removeEventListener('load', onLoad)
        image.removeEventListener('error', onError)
        imageRef.current = null
      }
    }

    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.preload = 'auto'
    video.playsInline = true

    const onLoadedData = () => {
      videoRef.current = video
      setMediaRevision((rev) => rev + 1)
    }
    const onError = () => {
      setReady(false)
    }

    video.addEventListener('loadeddata', onLoadedData)
    video.addEventListener('error', onError)
    video.src = src
    videoRef.current = video

    return () => {
      video.removeEventListener('loadeddata', onLoadedData)
      video.removeEventListener('error', onError)
      video.pause()
      video.removeAttribute('src')
      video.load()
      videoRef.current = null
    }
  }, [clip.mediaType, src])

  // Frame/filter effect: seek and grade paused frames using cached elements and graded ImageData cache.
  useEffect(() => {
    if (isPlaying || !src) {
      setReady(false)
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return

    if (canvas.width !== PAUSED_GRADE_WIDTH) canvas.width = PAUSED_GRADE_WIDTH
    if (canvas.height !== PAUSED_GRADE_HEIGHT) canvas.height = PAUSED_GRADE_HEIGHT

    const sourceFrame =
      clip.mediaType === 'image'
        ? 0
        : Math.min(
            (clip.mediaStart ?? 0) + frame,
            clip.mediaEnd ?? Number.MAX_SAFE_INTEGER
          )
    const cacheKey = `${src}|${filter}|${PAUSED_GRADE_WIDTH}x${PAUSED_GRADE_HEIGHT}|${clip.mediaType === 'image' ? 'image' : sourceFrame}`
    const cached = gradedFrameCache.get(cacheKey)
    if (cached) {
      context.putImageData(cached, 0, 0)
      setReady(true)
      return
    }

    let cancelled = false

    const paint = async (element: CanvasImageSource) => {
      if (cancelled) return
      if (!drawCoverCrop(context, element, canvas.width, canvas.height)) {
        setReady(false)
        return
      }
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      await applyPixelFilterInPlace(image.data, filter)
      if (cancelled) return
      rememberGradedFrame(cacheKey, image)
      context.putImageData(image, 0, 0)
      setReady(true)
    }

    if (clip.mediaType === 'image') {
      const image = imageRef.current
      if (!image || !image.complete || image.naturalWidth === 0) return
      paint(image).catch(() => {
        if (!cancelled) setReady(false)
      })
      return () => {
        cancelled = true
      }
    }

    const video = videoRef.current
    if (!video || video.readyState < 2) return

    const seconds = sourceFrame / Math.max(fps, 1)
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds
    const targetTime = Math.min(Math.max(0, seconds), duration)

    if (Math.abs(video.currentTime - targetTime) < 0.005) {
      paint(video).catch(() => {
        if (!cancelled) setReady(false)
      })
      return () => {
        cancelled = true
      }
    }

    const onSeeked = () => {
      paint(video).catch(() => {
        if (!cancelled) setReady(false)
      })
    }

    video.addEventListener('seeked', onSeeked, { once: true })
    try {
      video.currentTime = targetTime
    } catch {
      video.removeEventListener('seeked', onSeeked)
    }

    return () => {
      cancelled = true
      video.removeEventListener('seeked', onSeeked)
    }
  }, [clip.mediaEnd, clip.mediaStart, clip.mediaType, filter, fps, frame, isPlaying, mediaRevision, src])

  if (isPlaying) return null

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        opacity: ready ? 1 : 0,
      }}
    />
  )
}

const getMediaFailureMessage = (clip: Clip, error?: string) => {
  if (error && error.trim().length > 0) {
    return error.trim()
  }

  return `Unable to load ${clip.mediaType ?? 'media'} for this clip.`
}

const MediaFailureOverlay: React.FC<{
  message: string
  opacity: number
}> = ({ message, opacity }) => (
  <AbsoluteFill
    style={{
      opacity,
      background: 'linear-gradient(135deg, rgba(18,18,18,0.76), rgba(6,6,6,0.9))',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 36px',
    }}
  >
    <div
      style={{
        width: 'min(100%, 520px)',
        borderRadius: 14,
        border: '1px solid rgba(251,191,36,0.42)',
        background: 'rgba(10,10,10,0.84)',
        boxShadow: '0 16px 44px rgba(0,0,0,0.32)',
        padding: '20px 24px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.1,
          color: '#fbbf24',
          fontFamily: 'monospace',
        }}
      >
        MEDIA ERROR
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 13,
          lineHeight: 1.5,
          color: '#c6c6c6',
        }}
      >
        {message}
      </div>
    </div>
  </AbsoluteFill>
)

const VideoClipRenderer: React.FC<{
  clip: Clip
  opacity: number
  muted: boolean
  trimBefore?: number
  trimAfter?: number
}> = ({ clip, opacity, muted, trimBefore, trimAfter }) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setErrorMessage(null)
  }, [clip.id, clip.assetUrl, clip.previewUrl, clip.mediaStart, clip.mediaEnd])

  if (errorMessage) {
    return (
      <MediaFailureOverlay
        message={getMediaFailureMessage(clip, errorMessage)}
        opacity={opacity}
      />
    )
  }

  const src = playbackSrc(clip)
  const cssFilter = clip.pixelFilter ? cssFilterFor(clip.pixelFilter) : undefined

  return (
    <AbsoluteFill style={{ opacity }}>
      <Html5Video
        src={src}
        muted={muted}
        trimBefore={trimBefore}
        trimAfter={trimAfter}
        onError={(error) => setErrorMessage(error.message)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', filter: cssFilter }}
      />
      {clip.pixelFilter && <PausedWasmGrade clip={clip} src={src} filter={clip.pixelFilter} />}
    </AbsoluteFill>
  )
}

const AudioClipRenderer: React.FC<{
  clip: Clip
  muted: boolean
  trimBefore?: number
  trimAfter?: number
}> = ({ clip, muted, trimBefore, trimAfter }) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setErrorMessage(null)
  }, [clip.id, clip.assetUrl, clip.mediaStart, clip.mediaEnd])

  if (muted) return null

  if (errorMessage) {
    return (
      <MediaFailureOverlay
        message={getMediaFailureMessage(clip, errorMessage)}
        opacity={1}
      />
    )
  }

  return (
    <Html5Audio
      src={clip.assetUrl!}
      trimBefore={trimBefore}
      trimAfter={trimAfter}
      onError={(error) => setErrorMessage(error.message)}
    />
  )
}

const ImageClipRenderer: React.FC<{ clip: Clip; opacity: number }> = ({ clip, opacity }) => {
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    setHasError(false)
  }, [clip.id, clip.assetUrl, clip.previewUrl])

  if (hasError) {
    return (
      <MediaFailureOverlay
        message={getMediaFailureMessage(clip)}
        opacity={opacity}
      />
    )
  }

  const src = playbackSrc(clip)
  const cssFilter = clip.pixelFilter ? cssFilterFor(clip.pixelFilter) : undefined

  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={src}
        onError={() => setHasError(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', filter: cssFilter }}
      />
      {clip.pixelFilter && <PausedWasmGrade clip={clip} src={src} filter={clip.pixelFilter} />}
    </AbsoluteFill>
  )
}

const ClipRenderer: React.FC<{ clip: Clip; trackMuted: boolean }> = ({ clip, trackMuted }) => {
  if (!validateClip(clip)) {
    return null
  }

  const opacity = clip.opacity ?? 1

  if (clip.mediaType === 'text' && clip.text) {
    return (
      <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity }}>
        <div
          style={{
            fontSize: clip.fontSize || 48,
            fontWeight: 800,
            color: clip.fontColor || '#ffffff',
            textAlign: 'center',
            textShadow: '2px 2px 8px rgba(0,0,0,0.7)',
            padding: '0 40px',
          }}
        >
          {clip.text}
        </div>
      </AbsoluteFill>
    )
  }

  if (clip.isMissingAsset) {
    return (
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          padding: 20,
          opacity,
        }}
      >
        <div
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            background: 'rgba(18, 18, 18, 0.86)',
            border: '1px dashed rgba(251,191,36,0.65)',
            color: '#fbbf24',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 0.4,
          }}
        >
          Missing media: {clip.label}
        </div>
      </AbsoluteFill>
    )
  }

  const trimProps = getSafeMediaTrimProps(clip)

  if (clip.mediaType === 'video' && clip.assetUrl) {
    return (
      <VideoClipRenderer
        clip={clip}
        opacity={opacity}
        muted={trackMuted}
        trimBefore={trimProps.trimBefore}
        trimAfter={trimProps.trimAfter}
      />
    )
  }

  if (clip.mediaType === 'audio' && clip.assetUrl) {
    return (
      <AudioClipRenderer
        clip={clip}
        muted={trackMuted}
        trimBefore={trimProps.trimBefore}
        trimAfter={trimProps.trimAfter}
      />
    )
  }

  if (clip.mediaType === 'image' && clip.assetUrl) {
    return (
      <ImageClipRenderer clip={clip} opacity={opacity} />
    )
  }

  return null
}

const ProposedGlowOutline: React.FC = () => {
  const frame = useCurrentFrame()
  const glowOpacity = interpolate(frame % 60, [0, 30, 60], [0.35, 0.8, 0.35])

  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        outline: `2px solid rgba(99,160,255,${glowOpacity})`,
        boxShadow: `inset 0 0 60px rgba(99,160,255,${glowOpacity * 0.15})`,
        zIndex: 999,
      }}
    />
  )
}

export interface TrackPreviewProps {
  tracks: Track[]
  totalFrames: number
  isProposed?: boolean
}

export const TrackPreviewComposition: React.FC<TrackPreviewProps> = ({
  tracks,
  isProposed = false,
}) => {
  // FIX: 1 - validate clips before preview render so bad trim values never hit Remotion.
  const orderedSafeTracks = useMemo(
    () =>
      sortTracksForRender(tracks).map((track) => ({
        ...track,
        clips: track.clips.filter(validateClip),
      })),
    [tracks]
  )

  const hasMediaClips = orderedSafeTracks.some((track) =>
    track.clips.some((clip) => clip.assetUrl || clip.isMissingAsset || (clip.mediaType === 'text' && clip.text))
  )

  return (
    <AbsoluteFill style={{ background: '#0e0e0e' }}>
      {hasMediaClips && (
        <AbsoluteFill style={{ zIndex: 0 }}>
          {orderedSafeTracks.map((track) =>
            track.clips
              .filter((clip) => clip.assetUrl || clip.isMissingAsset || (clip.mediaType === 'text' && clip.text))
              .map((clip) => (
                <Sequence
                  key={clip.id}
                  from={clip.startFrame}
                  durationInFrames={clip.endFrame - clip.startFrame + 1}
                  layout="none"
                >
                  <ClipRenderer clip={clip} trackMuted={Boolean(track.muted || isProposed)} />
                </Sequence>
              ))
          )}
        </AbsoluteFill>
      )}
      {isProposed && <ProposedGlowOutline />}
    </AbsoluteFill>
  )
}
