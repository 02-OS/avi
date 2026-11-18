// FIX: 1 - centralize clip validation and safe trim computation for preview/render.
import type { Clip, Track } from '../store/useEditorStore'

const MIN_RENDERABLE_FRAMES = 1

export const getClipDurationFrames = (clip: Clip) => Math.max(0, clip.endFrame - clip.startFrame + 1)

export const getClipTrimInFrames = (clip: Clip) =>
  clip.mediaStart != null ? Math.max(0, Math.floor(clip.mediaStart)) : 0

export const getClipTrimOutFrames = (clip: Clip) =>
  clip.mediaDurationFrames != null && clip.mediaEnd != null
    ? Math.max(0, Math.floor(clip.mediaDurationFrames) - Math.floor(clip.mediaEnd) - 1)
    : 0

export function validateClip(clip: Clip): boolean {
  const durationFrames = getClipDurationFrames(clip)
  const trimIn = getClipTrimInFrames(clip)
  const trimOut = getClipTrimOutFrames(clip)
  const sourceDurationFrames = clip.mediaDurationFrames != null
    ? Math.max(0, Math.floor(clip.mediaDurationFrames))
    : durationFrames
  const renderedSourceFrames = clip.mediaStart != null && clip.mediaEnd != null
    ? clip.mediaEnd - clip.mediaStart + 1
    : durationFrames

  return (
    durationFrames > 0 &&
    clip.startFrame >= 0 &&
    clip.endFrame >= clip.startFrame &&
    trimIn >= 0 &&
    trimOut >= 0 &&
    sourceDurationFrames - trimIn - trimOut >= MIN_RENDERABLE_FRAMES &&
    renderedSourceFrames >= MIN_RENDERABLE_FRAMES
  )
}

export function repairClip(clip: Clip): Clip | null {
  const startFrame = Math.max(0, Math.floor(clip.startFrame))
  const endFrame = Math.max(startFrame, Math.floor(clip.endFrame))
  const mediaDurationFrames = clip.mediaDurationFrames != null
    ? Math.max(1, Math.floor(clip.mediaDurationFrames))
    : undefined

  let mediaStart = clip.mediaStart != null ? Math.max(0, Math.floor(clip.mediaStart)) : undefined
  let mediaEnd = clip.mediaEnd != null ? Math.max(0, Math.floor(clip.mediaEnd)) : undefined

  if (mediaDurationFrames != null) {
    if (mediaStart != null) {
      mediaStart = Math.min(mediaStart, mediaDurationFrames - 1)
    }
    if (mediaEnd != null) {
      mediaEnd = Math.min(mediaEnd, mediaDurationFrames - 1)
    }
  }

  if (mediaStart != null && mediaEnd != null && mediaEnd < mediaStart) {
    mediaEnd = mediaStart
  }

  const repairedClip: Clip = {
    ...clip,
    startFrame,
    endFrame,
    mediaDurationFrames,
    mediaStart,
    mediaEnd,
  }

  return validateClip(repairedClip) ? repairedClip : null
}

export function repairTracks(tracks: Track[]): {
  tracks: Track[]
  removedCount: number
  repairedCount: number
} {
  let removedCount = 0
  let repairedCount = 0

  const repairedTracks = tracks.map((track) => {
    const clips = track.clips.flatMap((clip) => {
      const repairedClip = repairClip(clip)

      if (!repairedClip) {
        removedCount += 1
        return []
      }

      if (JSON.stringify(repairedClip) !== JSON.stringify(clip)) {
        repairedCount += 1
      }

      return [repairedClip]
    })

    return { ...track, clips }
  })

  return {
    tracks: repairedTracks,
    removedCount,
    repairedCount,
  }
}

export function normalizeTimeline(tracks: Track[]): {
  tracks: Track[]
  offsetFrames: number
} {
  // Preserve intentional intro gaps; only clamp negative start frames if any slipped through.
  const hasNegative = tracks.some((track) =>
    track.clips.some((clip) => clip.startFrame < 0 || clip.endFrame < 0)
  )
  if (!hasNegative) {
    return { tracks, offsetFrames: 0 }
  }

  return {
    tracks: tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        const shift = clip.startFrame < 0 ? -clip.startFrame : 0
        return {
          ...clip,
          startFrame: Math.max(0, clip.startFrame + shift),
          endFrame: Math.max(0, clip.endFrame + shift),
        }
      }),
    })),
    offsetFrames: 0,
  }
}

export function getSafeMediaTrimProps(clip: Clip): {
  trimBefore?: number
  trimAfter?: number
} {
  const trimBeforeFrames = getClipTrimInFrames(clip)
  const trimBefore = trimBeforeFrames > 0 ? trimBeforeFrames : undefined

  if (clip.mediaEnd == null) {
    return { trimBefore, trimAfter: undefined }
  }

  // Remotion 4 trimAfter is the exclusive end source-frame coordinate (strictly > trimBefore).
  const trimAfterCandidate = Math.floor(clip.mediaEnd) + 1
  const hasTailTrim =
    clip.mediaDurationFrames == null ||
    trimAfterCandidate < Math.floor(clip.mediaDurationFrames)
  const trimAfter =
    hasTailTrim && trimAfterCandidate > trimBeforeFrames
      ? trimAfterCandidate
      : undefined

  return {
    trimBefore,
    trimAfter,
  }
}
