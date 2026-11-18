import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useEditorStore, type Track } from '../../store/useEditorStore'
import { TimelineRuler } from './TimelineRuler'
import { TimelineTrack } from './TimelineTrack'
import { Playhead } from './Playhead'
import { SelectionOverlay } from './SelectionOverlay'
import { isPixelFilter, PIXEL_FILTERS } from '../../lib/pixelFilter'
import { snapStart } from '../../lib/timelineEdit'
import { toast } from '../../lib/toastStore'
import {
  PIXELS_PER_FRAME,
  TRACK_HEIGHT,
  RULER_HEIGHT,
  TRACK_LABEL_WIDTH,
} from './constants'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

const TYPE_COLOR: Record<string, string> = {
  video: '#e94560',
  audio: '#059669',
  overlay: '#7c3aed',
}

const TYPE_ICON: Record<string, string> = {
  video: '▶',
  audio: '♪',
  overlay: '◈',
}

const actionButtonStyle = (enabled: boolean): React.CSSProperties => ({
  background: enabled ? '#252525' : '#1d1d1d',
  border: '1px solid #333',
  borderRadius: 5,
  color: enabled ? '#bbb' : '#555',
  fontSize: 11,
  fontWeight: 600,
  padding: '4px 10px',
  cursor: enabled ? 'pointer' : 'not-allowed',
})

type ResizeDragState = {
  trackId: string
  clipId: string
  edge: 'left' | 'right'
} | null

type SelectionDragState = {
  active: boolean
  startFrame: number
  didSelect: boolean
}

type MoveDragState = {
  trackId: string
  clipId: string
  originFrame: number
  originStart: number
  moved: boolean
} | null

export const Timeline: React.FC = () => {
  const compositionTree       = useEditorStore((s) => s.compositionTree)
  const totalFrames           = useEditorStore((s) => s.totalFrames)
  const currentSelection      = useEditorStore((s) => s.currentSelection)
  const selectedClip          = useEditorStore((s) => s.selectedClip)
  const timelineResetVersion  = useEditorStore((s) => s.timelineResetVersion)
  const setPlayheadPosition   = useEditorStore((s) => s.setPlayheadPosition)
  const setSelection          = useEditorStore((s) => s.setSelection)
  const setSelectedClip       = useEditorStore((s) => s.setSelectedClip)
  const openAssetPicker       = useEditorStore((s) => s.openAssetPicker)
  const closeAssetPicker      = useEditorStore((s) => s.closeAssetPicker)
  const removeClip            = useEditorStore((s) => s.removeClip)
  const duplicateClip         = useEditorStore((s) => s.duplicateClip)
  const splitClip             = useEditorStore((s) => s.splitClip)
  const trimClip              = useEditorStore((s) => s.trimClip)
  const moveClip              = useEditorStore((s) => s.moveClip)
  const rippleDeleteClip      = useEditorStore((s) => s.rippleDeleteClip)
  const setClipPixelFilter    = useEditorStore((s) => s.setClipPixelFilter)
  const commitHistoryCheckpoint = useEditorStore((s) => s.commitHistoryCheckpoint)
  const cleanMissingClips     = useEditorStore((s) => s.cleanMissingClips)
  const addTrack              = useEditorStore((s) => s.addTrack)
  const removeTrack           = useEditorStore((s) => s.removeTrack)
  const toggleTrackMute       = useEditorStore((s) => s.toggleTrackMute)

  const [zoom, setZoom] = useState(1)
  const pixelsPerFrame = PIXELS_PER_FRAME * zoom

  const scrollRef = useRef<HTMLDivElement>(null)
  const labelsScrollRef = useRef<HTMLDivElement>(null)
  const selDrag = useRef<SelectionDragState>({ active: false, startFrame: 0, didSelect: false })
  const phDrag = useRef({ active: false })
  const resizeDrag = useRef<ResizeDragState>(null)
  const moveDrag = useRef<MoveDragState>(null)

  const totalWidth = totalFrames * pixelsPerFrame
  const totalTracksHeight = Math.max(TRACK_HEIGHT, compositionTree.length * TRACK_HEIGHT)

  const missingClipCount = useMemo(
    () =>
      compositionTree.reduce(
        (count, track) =>
          count + track.clips.filter((clip) => clip.isMissingAsset || clip.status === 'missing').length,
        0
      ),
    [compositionTree]
  )

  const selectedClipData = useMemo(() => {
    if (!selectedClip) return null

    const track = compositionTree.find((item) => item.id === selectedClip.trackId)
    if (!track) return null

    return track.clips.find((clip) => clip.id === selectedClip.clipId) ?? null
  }, [compositionTree, selectedClip])

  useEffect(() => {
    if (!selectedClip || !selectedClipData) return

    setSelection({
      startFrame: selectedClipData.startFrame,
      endFrame: selectedClipData.endFrame,
    })
  }, [selectedClip, selectedClipData, setSelection])

  useEffect(() => {
    // FIX: 3 - reset the timeline viewport after project hydration so reloads start at frame 0.
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0
      scrollRef.current.scrollTop = 0
    }
    if (labelsScrollRef.current) {
      labelsScrollRef.current.scrollTop = 0
    }
  }, [timelineResetVersion])

  const clientXToFrame = useCallback(
    (clientX: number, clampToTimeline = true): number => {
      const scrollElement = scrollRef.current
      if (!scrollElement) return 0
      const rect = scrollElement.getBoundingClientRect()
      const scrollLeft = scrollElement.scrollLeft
      const x = clientX - rect.left + scrollLeft
      const frame = Math.max(0, Math.floor(x / pixelsPerFrame))
      if (!clampToTimeline) return frame
      return Math.min(frame, Math.max(0, totalFrames - 1))
    },
    [pixelsPerFrame, totalFrames]
  )

  const beginScrub = useCallback(
    (clientX: number) => {
      phDrag.current.active = true
      setPlayheadPosition(clientXToFrame(clientX))
    },
    [clientXToFrame, setPlayheadPosition]
  )

  const handleSplitSelected = useCallback(() => {
    if (!selectedClip || !selectedClipData) {
      toast.warning('Select a clip to split')
      return
    }

    const playheadPosition = useEditorStore.getState().playheadPosition
    if (playheadPosition <= selectedClipData.startFrame || playheadPosition > selectedClipData.endFrame) {
      toast.warning('Move the playhead inside the selected clip to split it')
      return
    }

    const didSplit = splitClip(selectedClip.trackId, selectedClip.clipId, playheadPosition)
    if (!didSplit) {
      toast.warning('Unable to split this clip at the current playhead position')
    }
  }, [selectedClip, selectedClipData, splitClip])

  const handleDuplicateSelected = useCallback(() => {
    if (!selectedClip) {
      toast.warning('Select a clip to duplicate')
      return
    }

    duplicateClip(selectedClip.trackId, selectedClip.clipId)
  }, [duplicateClip, selectedClip])

  const handleDeleteSelected = useCallback(() => {
    if (!selectedClip) {
      toast.warning('Select a clip to delete')
      return
    }

    removeClip(selectedClip.trackId, selectedClip.clipId)
    closeAssetPicker()
    setSelection(null)
  }, [closeAssetPicker, removeClip, selectedClip, setSelection])

  const handleRippleDeleteSelected = useCallback(() => {
    if (!selectedClip) {
      toast.warning('Select a clip to ripple delete')
      return
    }

    rippleDeleteClip(selectedClip.trackId, selectedClip.clipId)
    closeAssetPicker()
    setSelection(null)
  }, [closeAssetPicker, rippleDeleteClip, selectedClip, setSelection])

  const handleAddTrack = useCallback((type: Track['type']) => {
    const count = compositionTree.filter((t) => t.type === type).length + 1
    const label = type === 'video' ? `Video ${count}` : type === 'audio' ? `Audio ${count}` : `Overlay ${count}`
    addTrack(label, type)
  }, [addTrack, compositionTree])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (phDrag.current.active) {
        setPlayheadPosition(clientXToFrame(event.clientX))
        return
      }

      if (moveDrag.current) {
        const frame = clientXToFrame(event.clientX, false)
        const drag = moveDrag.current
        const state = useEditorStore.getState()
        const activeTrack = state.compositionTree.find((track) => track.id === drag.trackId)
        const activeClip = activeTrack?.clips.find((clip) => clip.id === drag.clipId)
        if (!activeClip) return

        const duration = activeClip.endFrame - activeClip.startFrame
        const targets = [0, state.playheadPosition]
        for (const track of state.compositionTree) {
          for (const clip of track.clips) {
            if (clip.id === drag.clipId) continue
            targets.push(clip.startFrame, clip.endFrame + 1)
          }
        }

        const snapThreshold = Math.max(2, Math.round(8 / zoom))
        const nextStart = snapStart(drag.originStart + (frame - drag.originFrame), duration, targets, snapThreshold)
        if (nextStart !== activeClip.startFrame) {
          drag.moved = true
          moveClip(drag.trackId, drag.clipId, nextStart, false)
        }
        return
      }

      if (resizeDrag.current) {
        const edge = resizeDrag.current.edge
        const frame = clientXToFrame(event.clientX, edge === 'left')
        const activeTrack = useEditorStore
          .getState()
          .compositionTree
          .find((track) => track.id === resizeDrag.current?.trackId)
        const activeClip = activeTrack?.clips.find((clip) => clip.id === resizeDrag.current?.clipId)
        if (!activeClip) return

        if (edge === 'left') {
          trimClip(activeTrack!.id, activeClip.id, frame, activeClip.endFrame, 'left')
        } else {
          trimClip(activeTrack!.id, activeClip.id, activeClip.startFrame, frame, 'right')
        }
        return
      }

      if (!selDrag.current.active) return

      const frame = clientXToFrame(event.clientX)
      const { startFrame, didSelect } = selDrag.current
      if (frame === startFrame && !didSelect) return

      selDrag.current.didSelect = true
      setSelection({
        startFrame: Math.min(startFrame, frame),
        endFrame: Math.max(startFrame, frame),
      })
    }

    const onMouseUp = () => {
      if (moveDrag.current?.moved) {
        commitHistoryCheckpoint()
      }
      moveDrag.current = null

      if (resizeDrag.current) {
        resizeDrag.current = null
        commitHistoryCheckpoint()
      }

      if (selDrag.current.active && !selDrag.current.didSelect) {
        setSelection(null)
      }

      selDrag.current = { active: false, startFrame: 0, didSelect: false }
      phDrag.current.active = false
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [clientXToFrame, commitHistoryCheckpoint, moveClip, setPlayheadPosition, setSelection, trimClip, zoom])

  const handleTracksMouseDown = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-clip]') || target.closest('[data-playhead]')) return

    const frame = clientXToFrame(event.clientX)
    selDrag.current = { active: true, startFrame: frame, didSelect: false }
    setSelectedClip(null)
    closeAssetPicker()
    setSelection(null)
    setPlayheadPosition(frame)
  }

  const handlePlayheadMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    beginScrub(event.clientX)
  }, [beginScrub])

  const handleRulerMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    beginScrub(event.clientX)
  }, [beginScrub])

  const handleSelectClip = useCallback((trackId: string, clipId: string, event: React.MouseEvent) => {
    event.stopPropagation()
    setSelectedClip({ trackId, clipId })
    const selected = useEditorStore
      .getState()
      .compositionTree
      .find((track) => track.id === trackId)
      ?.clips.find((clip) => clip.id === clipId)
    if (selected) {
      moveDrag.current = {
        trackId,
        clipId,
        originFrame: clientXToFrame(event.clientX, false),
        originStart: selected.startFrame,
        moved: false,
      }
    }
  }, [clientXToFrame, setSelectedClip])

  const handleDoubleClickClip = useCallback((trackId: string, clipId: string) => {
    const selected = useEditorStore
      .getState()
      .compositionTree
      .find((track) => track.id === trackId)
      ?.clips.find((clip) => clip.id === clipId)
    if (!selected || selected.mediaType === 'text') return
    openAssetPicker({ trackId, clipId })
  }, [openAssetPicker])

  const handleTrimStart = useCallback((
    trackId: string,
    clipId: string,
    edge: 'left' | 'right',
    event: React.MouseEvent
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedClip({ trackId, clipId })
    resizeDrag.current = { trackId, clipId, edge }
  }, [setSelectedClip])

  const handleWheelZoom = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    setZoom((prev) => {
      const factor = event.deltaY < 0 ? 1.15 : 0.87
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((prev * factor).toFixed(2))))
    })
  }, [])

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#161616',
        borderTop: '1px solid #2e2e2e',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          height: 32,
          background: '#1c1c1c',
          borderBottom: '1px solid #2e2e2e',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          flexShrink: 0,
          gap: 6,
          overflowX: 'auto',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: 1 }}>
          TIMELINE
        </span>

        <button onClick={handleSplitSelected} disabled={!selectedClipData} style={actionButtonStyle(Boolean(selectedClipData))}>
          Split (S)
        </button>
        <button onClick={handleDuplicateSelected} disabled={!selectedClipData} style={actionButtonStyle(Boolean(selectedClipData))}>
          Duplicate (D)
        </button>
        <button onClick={handleDeleteSelected} disabled={!selectedClipData} style={actionButtonStyle(Boolean(selectedClipData))}>
          Delete
        </button>
        <button onClick={handleRippleDeleteSelected} disabled={!selectedClipData} style={actionButtonStyle(Boolean(selectedClipData))}>
          Ripple
        </button>
        {selectedClip && selectedClipData && selectedClipData.mediaType !== 'text' && (
          <button
            onClick={() => openAssetPicker(selectedClip)}
            style={actionButtonStyle(true)}
            title="Replace selected clip media asset (or double-click clip)"
          >
            Replace
          </button>
        )}
        {selectedClip && selectedClipData && (selectedClipData.mediaType === 'video' || selectedClipData.mediaType === 'image') && (
          <select
            aria-label="Pixel filter"
            value={selectedClipData.pixelFilter ?? ''}
            onChange={(event) => {
              const value = event.target.value
              setClipPixelFilter(
                selectedClip.trackId,
                selectedClip.clipId,
                value && isPixelFilter(value) ? value : null
              )
            }}
            style={{
              background: '#252525',
              border: '1px solid #333',
              borderRadius: 5,
              color: '#bbb',
              fontSize: 11,
              padding: '4px 8px',
            }}
          >
            <option value="">No filter</option>
            {PIXEL_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {filter}
              </option>
            ))}
          </select>
        )}

        {missingClipCount > 0 && (
          <button
            onClick={cleanMissingClips}
            style={{
              background: 'rgba(251, 191, 36, 0.14)',
              border: '1px solid rgba(251, 191, 36, 0.45)',
              borderRadius: 5,
              color: '#fbbf24',
              fontSize: 11,
              fontWeight: 600,
              padding: '4px 9px',
              cursor: 'pointer',
            }}
            title="Remove clips whose source asset is missing"
          >
            Clean Missing ({missingClipCount})
          </button>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
          <button
            onClick={() => handleAddTrack('video')}
            style={actionButtonStyle(true)}
            title="Add video track"
          >
            + Video
          </button>
          <button
            onClick={() => handleAddTrack('audio')}
            style={actionButtonStyle(true)}
            title="Add audio track"
          >
            + Audio
          </button>
          <button
            onClick={() => handleAddTrack('overlay')}
            style={actionButtonStyle(true)}
            title="Add overlay track"
          >
            + Overlay
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
          <button
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Number((z / 1.25).toFixed(2))))}
            aria-label="Zoom out timeline"
            title="Zoom out"
            style={actionButtonStyle(zoom > MIN_ZOOM)}
            disabled={zoom <= MIN_ZOOM}
          >
            −
          </button>
          <button
            onClick={() => setZoom(1)}
            title="Reset timeline zoom"
            style={{ ...actionButtonStyle(true), minWidth: 44 }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Number((z * 1.25).toFixed(2))))}
            aria-label="Zoom in timeline"
            title="Zoom in"
            style={actionButtonStyle(zoom < MAX_ZOOM)}
            disabled={zoom >= MAX_ZOOM}
          >
            +
          </button>
        </div>

        {selectedClipData && (
          <span style={{ fontSize: 11, color: selectedClipData.isMissingAsset ? '#fbbf24' : '#888', whiteSpace: 'nowrap' }}>
            {selectedClipData.label} [{selectedClipData.startFrame} - {selectedClipData.endFrame}]
          </span>
        )}

        {currentSelection && (
          <span style={{ fontSize: 11, color: '#63a0ff', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            In {currentSelection.startFrame} | Out {currentSelection.endFrame} | {currentSelection.endFrame - currentSelection.startFrame + 1} frames
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div
          style={{
            width: TRACK_LABEL_WIDTH,
            flexShrink: 0,
            borderRight: '1px solid #2e2e2e',
            background: '#1a1a1a',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid #2e2e2e', flexShrink: 0 }} />

          <div
            ref={labelsScrollRef}
            style={{ flex: 1, overflowY: 'hidden' }}
          >
            {compositionTree.map((track) => (
              <div
                key={track.id}
                style={{
                  height: TRACK_HEIGHT,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 8px 0 10px',
                  gap: 6,
                  borderBottom: '1px solid #272727',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: TYPE_COLOR[track.type] ?? '#999',
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {TYPE_ICON[track.type] ?? '○'}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: track.muted ? '#666' : '#ccc',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={track.name}
                >
                  {track.name}
                </span>
                <button
                  onClick={() => toggleTrackMute(track.id)}
                  aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
                  aria-pressed={Boolean(track.muted)}
                  title={track.muted ? 'Unmute track' : 'Mute track'}
                  style={{
                    background: track.muted ? 'rgba(233,69,96,0.2)' : 'transparent',
                    border: '1px solid #2f2f2f',
                    borderRadius: 4,
                    color: track.muted ? '#e94560' : '#777',
                    fontSize: 11,
                    padding: '2px 5px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {track.muted ? '🔇' : '🔊'}
                </button>
                <button
                  onClick={() => removeTrack(track.id)}
                  disabled={compositionTree.length <= 1}
                  aria-label={`Delete track ${track.name}`}
                  title={compositionTree.length <= 1 ? 'At least one track is required' : 'Delete track'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: compositionTree.length <= 1 ? '#3a3a3a' : '#777',
                    fontSize: 13,
                    padding: '2px 4px',
                    cursor: compositionTree.length <= 1 ? 'not-allowed' : 'pointer',
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={() => {
            if (labelsScrollRef.current && scrollRef.current) {
              labelsScrollRef.current.scrollTop = scrollRef.current.scrollTop
            }
          }}
          onWheel={handleWheelZoom}
          style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}
          className="timeline-scroll"
        >
          <div style={{ width: totalWidth, position: 'relative' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 25 }}>
              <TimelineRuler
                totalFrames={totalFrames}
                pixelsPerFrame={pixelsPerFrame}
                onMouseDown={handleRulerMouseDown}
              />
            </div>

            <div
              style={{ position: 'relative', height: totalTracksHeight, cursor: 'crosshair' }}
              onMouseDown={handleTracksMouseDown}
            >
              <SelectionOverlay totalHeight={totalTracksHeight} pixelsPerFrame={pixelsPerFrame} />

              <Playhead
                totalHeight={totalTracksHeight}
                pixelsPerFrame={pixelsPerFrame}
                onHandleMouseDown={handlePlayheadMouseDown}
              />

              {compositionTree.map((track, index) => (
                <TimelineTrack
                  key={track.id}
                  track={track}
                  index={index}
                  pixelsPerFrame={pixelsPerFrame}
                  selectedClip={selectedClip}
                  onSelectClip={handleSelectClip}
                  onDoubleClickClip={handleDoubleClickClip}
                  onTrimStart={handleTrimStart}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
