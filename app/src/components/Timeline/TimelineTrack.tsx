import React from 'react'
import { type SelectedClip, type Track } from '../../store/useEditorStore'
import { ClipBlock } from './Clip'
import { PIXELS_PER_FRAME, TRACK_HEIGHT } from './constants'

interface Props {
  track: Track
  index: number
  selectedClip: SelectedClip | null
  pixelsPerFrame?: number
  onSelectClip: (trackId: string, clipId: string, event: React.MouseEvent) => void
  onDoubleClickClip: (trackId: string, clipId: string) => void
  onTrimStart: (trackId: string, clipId: string, edge: 'left' | 'right', event: React.MouseEvent) => void
}

export const TimelineTrack: React.FC<Props> = React.memo(({
  track,
  index,
  selectedClip,
  pixelsPerFrame = PIXELS_PER_FRAME,
  onSelectClip,
  onDoubleClickClip,
  onTrimStart,
}) => {
  return (
    <div
      style={{
        position: 'absolute',
        top: index * TRACK_HEIGHT,
        left: 0,
        right: 0,
        height: TRACK_HEIGHT,
        background: index % 2 === 0 ? '#1e1e1e' : '#1b1b1b',
        borderBottom: '1px solid #272727',
        opacity: track.muted ? 0.5 : 1,
      }}
    >
      {track.clips.map((clip) => (
        <ClipBlock
          key={clip.id}
          clip={clip}
          pixelsPerFrame={pixelsPerFrame}
          isSelected={selectedClip?.trackId === track.id && selectedClip.clipId === clip.id}
          onSelect={(event) => onSelectClip(track.id, clip.id, event)}
          onDoubleClick={() => onDoubleClickClip(track.id, clip.id)}
          onTrimStart={(event, edge) => onTrimStart(track.id, clip.id, edge, event)}
        />
      ))}
    </div>
  )
})
TimelineTrack.displayName = 'TimelineTrack'
