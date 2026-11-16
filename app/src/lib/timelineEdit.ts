import type { Clip } from '../store/useEditorStore'

export function movedClipRange(startFrame: number, endFrame: number, newStart: number) {
  const duration = Math.max(0, endFrame - startFrame)
  const nextStart = Math.max(0, Math.round(newStart))
  return {
    startFrame: nextStart,
    endFrame: nextStart + duration,
  }
}

export function snapStart(
  start: number,
  duration: number,
  targets: number[],
  threshold = 8
): number {
  const end = start + duration
  let bestStart = start
  let bestDistance = threshold + 1

  for (const target of targets) {
    const startDistance = Math.abs(target - start)
    if (startDistance <= threshold && startDistance < bestDistance) {
      bestStart = target
      bestDistance = startDistance
    }

    const endDistance = Math.abs(target - end)
    if (endDistance <= threshold && endDistance < bestDistance) {
      bestStart = target - duration
      bestDistance = endDistance
    }
  }

  return Math.max(0, bestStart)
}

export function rippleDelete(clips: Clip[], clipId: string): Clip[] {
  const clip = clips.find((item) => item.id === clipId)
  if (!clip) return clips

  const duration = clip.endFrame - clip.startFrame + 1
  return clips
    .filter((item) => item.id !== clipId)
    .map((item) => {
      if (item.startFrame <= clip.endFrame) return item
      return {
        ...item,
        startFrame: item.startFrame - duration,
        endFrame: item.endFrame - duration,
      }
    })
}

export function resolveTrimmedClip(
  clip: Clip,
  newStart: number,
  newEnd: number,
  edge?: 'left' | 'right'
): Clip {
  const activeEdge =
    edge ??
    (newEnd === clip.endFrame && newStart !== clip.startFrame
      ? 'left'
      : newStart === clip.startFrame && newEnd !== clip.endFrame
        ? 'right'
        : undefined)

  let startFrame: number
  let endFrame: number

  if (activeEdge === 'left') {
    endFrame = Math.max(0, clip.endFrame)
    startFrame = Math.max(0, Math.min(newStart, endFrame))
  } else if (activeEdge === 'right') {
    startFrame = Math.max(0, clip.startFrame)
    endFrame = Math.max(startFrame, newEnd)
  } else {
    startFrame = Math.max(0, Math.min(newStart, newEnd))
    endFrame = Math.max(startFrame, newEnd)
  }

  if (
    clip.mediaType &&
    clip.mediaType !== 'text' &&
    clip.mediaStart != null &&
    clip.mediaEnd != null
  ) {
    const minStart = Math.max(0, clip.startFrame - clip.mediaStart)
    if (activeEdge !== 'right') {
      startFrame = Math.max(minStart, Math.min(startFrame, endFrame))
    }

    let mediaStart = clip.mediaStart + (startFrame - clip.startFrame)

    const maxEnd =
      clip.mediaDurationFrames != null
        ? clip.endFrame + Math.max(clip.mediaDurationFrames - 1 - clip.mediaEnd, 0)
        : Number.MAX_SAFE_INTEGER

    endFrame = Math.max(startFrame, Math.min(endFrame, maxEnd))
    let mediaEnd = clip.mediaEnd + (endFrame - clip.endFrame)

    if (clip.mediaDurationFrames != null) {
      mediaEnd = Math.min(mediaEnd, clip.mediaDurationFrames - 1)
    }

    mediaStart = Math.max(0, mediaStart)
    mediaEnd = Math.max(mediaStart, mediaEnd)

    return {
      ...clip,
      startFrame,
      endFrame,
      mediaStart,
      mediaEnd,
    }
  }

  return {
    ...clip,
    startFrame,
    endFrame,
  }
}
