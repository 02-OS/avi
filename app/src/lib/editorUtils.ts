import type { Clip, Track } from '../store/useEditorStore'

export const MAX_BROWSER_UPLOAD_BYTES = 200 * 1024 * 1024
export const MAX_BROWSER_UPLOAD_LABEL = '200MB'

const TRACK_LAYER_PRIORITY: Record<Track['type'], number> = {
  audio: 0,
  video: 1,
  overlay: 2,
}

export const sortTracksForRender = (tracks: Track[]): Track[] =>
  [...tracks].sort((a, b) => TRACK_LAYER_PRIORITY[a.type] - TRACK_LAYER_PRIORITY[b.type])

export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
    return false
  }

  const tagName = target.tagName.toLowerCase()
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select'
}

export const flattenClips = (tracks: Track[]) => tracks.flatMap((track) => track.clips)

export const hasVideoClips = (tracks: Track[]) =>
  flattenClips(tracks).some((clip) => clip.mediaType === 'video')

export const hasUsableVideoClips = (tracks: Track[]) =>
  flattenClips(tracks).some((clip) => clip.mediaType === 'video' && clip.assetUrl && !clip.isMissingAsset)

export const hasMissingRenderableMedia = (tracks: Track[]) =>
  flattenClips(tracks).some(
    (clip) =>
      clip.mediaType !== 'text' &&
      Boolean(clip.assetId) &&
      (!clip.assetUrl || clip.isMissingAsset)
  )

export const hasRenderableContent = (tracks: Track[]) =>
  flattenClips(tracks).some((clip) => {
    if (clip.mediaType === 'text') {
      return Boolean(clip.text)
    }

    return Boolean(clip.assetUrl) && !clip.isMissingAsset
  })

export const getClipDurationFrames = (clip: Clip) => clip.endFrame - clip.startFrame + 1
