import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { TrackPreviewComposition, type TrackPreviewProps } from '../../remotion/compositions/TrackPreviewComposition'
import { useEditorStore } from '../../store/useEditorStore'
import { ensureProjectAssets, useAssetStore, type Asset } from '../../lib/assetService'
import { useModalFocusTrap } from '../../hooks/useModalFocusTrap'
import { toast } from '../../lib/toastStore'
import { GhostPreviewBar } from './GhostPreviewBar'

// ── Transport icon components ────────────────────────────────────────────────
const IconPlay      = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
const IconPause     = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
const IconSkipBack  = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
const IconSkipFwd   = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zm2.5-6L14 7v10z"/><path d="M16 6h2v12h-2z"/></svg>

const getActiveClipLabels = (
  tracks: TrackPreviewProps['tracks'],
  frame: number
): string[] =>
  Array.from(
    new Set(
      tracks
        .flatMap((track) =>
          track.clips
            .filter((clip) => frame >= clip.startFrame && frame <= clip.endFrame)
            .map((clip) => clip.label.trim())
        )
        .filter((label) => label.length > 0)
    )
  ).slice(0, 3)

const ActiveClipLabelsOverlay: React.FC<{ tracks: TrackPreviewProps['tracks'] }> = React.memo(({ tracks }) => {
  const playheadPosition = useEditorStore((s) => s.playheadPosition)
  const labels = useMemo(
    () => getActiveClipLabels(tracks, playheadPosition),
    [tracks, playheadPosition]
  )

  if (labels.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: 8,
        bottom: 8,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        pointerEvents: 'none',
        maxWidth: 'calc(100% - 16px)',
      }}
    >
      {labels.map((clipLabel) => (
        <span
          key={clipLabel}
          style={{
            fontSize: 10,
            color: '#e5e7eb',
            background: 'rgba(15,15,15,0.74)',
            border: '1px solid rgba(99,99,99,0.45)',
            borderRadius: 4,
            padding: '3px 7px',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {clipLabel}
        </span>
      ))}
    </div>
  )
})
ActiveClipLabelsOverlay.displayName = 'ActiveClipLabelsOverlay'

// ── One player slot ──────────────────────────────────────────────────────────
interface PlayerSlotProps {
  playerRef:    React.RefObject<PlayerRef | null>
  tracks:       TrackPreviewProps['tracks']
  totalFrames:  number
  fps:          number
  label:        string
  isProposed?:  boolean
}

const formatPreviewError = (error: Error) => {
  const firstLine = error.message.split('\n')[0]?.trim()
  return firstLine && firstLine.length > 0
    ? firstLine
    : 'The preview failed while loading media for this frame.'
}

const PreviewErrorState: React.FC<{ error: Error; label: string; isProposed: boolean }> = ({
  error,
  label,
  isProposed,
}) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 28,
      background: 'radial-gradient(circle at top, rgba(48,48,48,0.65), rgba(10,10,10,0.96) 60%)',
      color: '#fff',
    }}
  >
    <div
      style={{
        width: 'min(100%, 460px)',
        borderRadius: 14,
        border: `1px solid ${isProposed ? 'rgba(99,160,255,0.42)' : 'rgba(233,69,96,0.38)'}`,
        background: 'rgba(12,12,12,0.88)',
        boxShadow: '0 20px 48px rgba(0,0,0,0.35)',
        padding: '22px 24px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.3,
          color: isProposed ? '#63a0ff' : '#f87171',
          fontFamily: 'monospace',
        }}
      >
        {label} PREVIEW ERROR
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 20,
          fontWeight: 700,
          color: '#f3f4f6',
        }}
      >
        Unable to render this frame
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 13,
          lineHeight: 1.5,
          color: '#b6b6b6',
        }}
      >
        {formatPreviewError(error)}
      </div>
      <div
        style={{
          marginTop: 14,
          fontSize: 12,
          lineHeight: 1.5,
          color: '#8b8b8b',
        }}
      >
        Check that the clip still has a valid local asset and that the selected frame is inside its media range.
      </div>
    </div>
  </div>
)

const PlayerSlot: React.FC<PlayerSlotProps> = React.memo(({
  playerRef, tracks, totalFrames, fps, label, isProposed = false,
}) => {
  const safeTotalFrames = Math.max(1, totalFrames)
  const inputProps = useMemo<TrackPreviewProps>(
    () => ({ tracks, totalFrames: safeTotalFrames, isProposed }),
    [tracks, safeTotalFrames, isProposed]
  )
  const errorFallback = useCallback(
    ({ error }: { error: Error }) => (
      <PreviewErrorState error={error} label={label} isProposed={isProposed} />
    ),
    [label, isProposed]
  )

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      }}
    >
      {/* Slot label */}
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 2,
          color: isProposed ? '#63a0ff' : '#666',
          fontFamily: 'monospace',
          textAlign: 'center',
        }}
      >
        {isProposed ? '✦ AI PREVIEW' : 'ORIGINAL'}
      </div>

      {/* Player */}
      <div
        style={{
          flex: 1,
          borderRadius: 10,
          overflow: 'hidden',
          outline: isProposed ? '1.5px solid rgba(99,160,255,0.4)' : '1px solid #2a2a2a',
          boxShadow: isProposed ? '0 0 20px rgba(99,160,255,0.12)' : 'none',
          position: 'relative',
        }}
      >
        <Player
          ref={playerRef as React.RefObject<PlayerRef>}
          component={TrackPreviewComposition as unknown as React.ComponentType<Record<string, unknown>>}
          inputProps={inputProps as unknown as Record<string, unknown>}
          durationInFrames={safeTotalFrames}
          compositionWidth={1280}
          compositionHeight={720}
          fps={fps}
          initialFrame={0}
          initiallyMuted={isProposed}
          errorFallback={errorFallback}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        <ActiveClipLabelsOverlay tracks={tracks} />
      </div>
    </div>
  )
})
PlayerSlot.displayName = 'PlayerSlot'

const PlayerScrubber: React.FC<{
  totalFrames: number
  fps: number
  isPlaying: boolean
  onTogglePlay: () => void
  onGoToStart: () => void
  onGoToEnd: () => void
}> = React.memo(({ totalFrames, fps, isPlaying, onTogglePlay, onGoToStart, onGoToEnd }) => {
  const playheadPosition = useEditorStore((s) => s.playheadPosition)
  const setPlayheadPosition = useEditorStore((s) => s.setPlayheadPosition)

  const maxFrame = Math.max(1, totalFrames - 1)
  const progressPct = totalFrames <= 1 ? '0.000' : ((playheadPosition / maxFrame) * 100).toFixed(3)
  const currentSec = (playheadPosition / Math.max(fps, 1)).toFixed(2)
  const totalSec = ((Math.max(1, totalFrames) - 1) / Math.max(fps, 1)).toFixed(2)

  const handleScrubberClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    setPlayheadPosition(totalFrames <= 1 ? 0 : Math.round(ratio * maxFrame))
  }

  const handleScrubberKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const upperBound = Math.max(0, totalFrames - 1)
    const step = event.shiftKey ? 10 : 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      setPlayheadPosition(Math.max(0, playheadPosition - step))
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      setPlayheadPosition(Math.min(upperBound, playheadPosition + step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setPlayheadPosition(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setPlayheadPosition(upperBound)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      setPlayheadPosition(Math.min(upperBound, playheadPosition + fps))
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      setPlayheadPosition(Math.max(0, playheadPosition - fps))
    }
  }

  return (
    <>
      {/* ── Scrubber ── */}
      <div style={{ padding: '8px 16px 0' }}>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Timeline playhead"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, totalFrames - 1)}
          aria-valuenow={playheadPosition}
          aria-valuetext={`Frame ${playheadPosition}, ${currentSec} seconds`}
          onClick={handleScrubberClick}
          onKeyDown={handleScrubberKeyDown}
          style={{
            height: 6,
            background: '#2a2a2a',
            borderRadius: 3,
            cursor: 'pointer',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute', left: 0, top: 0, height: '100%',
              width: `${progressPct}%`, background: '#e94560', borderRadius: 3, pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute', top: '50%', left: `${progressPct}%`,
              transform: 'translate(-50%,-50%)', width: 12, height: 12,
              borderRadius: '50%', background: '#e94560', pointerEvents: 'none',
              boxShadow: '0 0 0 2px rgba(233,69,96,0.35)',
            }}
          />
        </div>
      </div>

      {/* ── Transport ── */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 16px 12px', flexShrink: 0,
        }}
      >
        <button onClick={onGoToStart} style={btnStyle} title="Go to start" aria-label="Go to start">
          <IconSkipBack />
        </button>
        <button
          onClick={onTogglePlay}
          style={{ ...btnStyle, background: '#e94560', color: '#fff', width: 36, height: 36 }}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <IconPause /> : <IconPlay />}
        </button>
        <button onClick={onGoToEnd} style={btnStyle} title="Go to end" aria-label="Go to end">
          <IconSkipFwd />
        </button>

        <div
          style={{
            marginLeft: 'auto', fontFamily: 'monospace', fontSize: 12, color: '#aaa',
            background: '#1a1a1a', padding: '4px 10px', borderRadius: 4, border: '1px solid #2e2e2e',
          }}
        >
          <span style={{ color: '#e94560' }}>{currentSec}s</span>
          &nbsp;/&nbsp;{totalSec}s&nbsp;&nbsp;
          <span style={{ color: '#555' }}>f{playheadPosition}</span>
        </div>
      </div>
    </>
  )
})
PlayerScrubber.displayName = 'PlayerScrubber'

interface PlayerPanelProps {
  projectId: string | null
}

// ── Main PlayerPanel ─────────────────────────────────────────────────────────
export const PlayerPanel: React.FC<PlayerPanelProps> = ({ projectId }) => {
  const mainRef     = useRef<PlayerRef>(null)
  const proposedRef = useRef<PlayerRef>(null)
  const playerDrivenFrameRef = useRef<number | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [isPickerAssetsLoading, setIsPickerAssetsLoading] = useState(false)
  const [comparisonMode, setComparisonMode] = useState(false)

  const totalFrames         = useEditorStore((s) => s.totalFrames)
  const fps                 = useEditorStore((s) => s.fps)
  const isPlaying           = useEditorStore((s) => s.isPlaying)
  const compositionTree     = useEditorStore((s) => s.compositionTree)
  const proposedComposition = useEditorStore((s) => s.proposedComposition)
  const proposedMeta        = useEditorStore((s) => s.proposedMeta)
  const assetPickerClip     = useEditorStore((s) => s.assetPickerClip)
  const replaceClipAsset    = useEditorStore((s) => s.replaceClipAsset)
  const closeAssetPicker    = useEditorStore((s) => s.closeAssetPicker)
  const setPlayheadPosition = useEditorStore((s) => s.setPlayheadPosition)
  const setIsPlaying        = useEditorStore((s) => s.setIsPlaying)

  const cachedAssets = useAssetStore((s) => s.assets)

  const pickerClipData = useMemo(() => {
    if (!assetPickerClip) return null
    const track = compositionTree.find((item) => item.id === assetPickerClip.trackId)
    return track?.clips.find((clip) => clip.id === assetPickerClip.clipId) ?? null
  }, [assetPickerClip, compositionTree])

  const pickerAssetOptions = useMemo(() => {
    const readyAssets = cachedAssets.filter((asset) => asset.status === 'ready' && Boolean(asset.playback_url))
    if (!pickerClipData) return readyAssets

    if (pickerClipData.mediaType === 'video' || pickerClipData.mediaType === 'audio' || pickerClipData.mediaType === 'image') {
      return readyAssets.filter((asset) => asset.file_type === pickerClipData.mediaType)
    }

    return readyAssets
  }, [cachedAssets, pickerClipData])

  useEffect(() => {
    setComparisonMode(Boolean(proposedComposition))
  }, [proposedComposition])

  const hasComparisonSource = Boolean(proposedComposition)
  const isSplit = hasComparisonSource && comparisonMode

  // ── Seek both players when store playheadPosition changes externally ───────
  useEffect(() => {
    const syncSeek = (frame: number) => {
      if (playerDrivenFrameRef.current === frame) {
        playerDrivenFrameRef.current = null
        return
      }
      playerDrivenFrameRef.current = null
      mainRef.current?.seekTo(frame)
      if (isSplit) {
        proposedRef.current?.seekTo(frame)
      }
    }

    const unsubscribe = useEditorStore.subscribe((state, prevState) => {
      if (state.playheadPosition !== prevState.playheadPosition) {
        syncSeek(state.playheadPosition)
      }
    })

    // Sync proposed player immediately when split view opens.
    if (isSplit) {
      proposedRef.current?.mute()
      proposedRef.current?.seekTo(useEditorStore.getState().playheadPosition)
    }

    return unsubscribe
  }, [isSplit])

  // ── Play / pause both players ─────────────────────────────────────────────
  useEffect(() => {
    if (isPlaying) {
      mainRef.current?.play()
      if (isSplit) {
        proposedRef.current?.mute()
        proposedRef.current?.play()
      }
    } else {
      mainRef.current?.pause()
      if (isSplit) {
        proposedRef.current?.pause()
      }
    }
  }, [isPlaying, isSplit])

  // ── Primary player timeupdate → update store + drift-correct secondary ───
  useEffect(() => {
    const player = mainRef.current
    if (!player) return

    const onTimeUpdate = ({ detail }: { detail: { frame: number } }) => {
      const state = useEditorStore.getState()
      const maxFrame = Math.max(0, state.totalFrames - 1)
      const clamped = Math.max(0, Math.min(Math.round(detail.frame), maxFrame))

      if (clamped !== state.playheadPosition) {
        playerDrivenFrameRef.current = clamped
        setPlayheadPosition(clamped)
      }

      if (isSplit && proposedRef.current) {
        const proposedFrame = proposedRef.current.getCurrentFrame()
        if (!Number.isFinite(proposedFrame) || Math.abs(proposedFrame - clamped) > 2) {
          proposedRef.current.seekTo(clamped)
        }
      }
    }
    const onPlay  = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => { setIsPlaying(false); setPlayheadPosition(0) }

    player.addEventListener('timeupdate', onTimeUpdate)
    player.addEventListener('play',  onPlay)
    player.addEventListener('pause', onPause)
    player.addEventListener('ended', onEnded)
    return () => {
      player.removeEventListener('timeupdate', onTimeUpdate)
      player.removeEventListener('play',  onPlay)
      player.removeEventListener('pause', onPause)
      player.removeEventListener('ended', onEnded)
    }
  }, [setPlayheadPosition, setIsPlaying, isSplit])

  useEffect(() => {
    if (!assetPickerClip || !projectId) {
      setIsPickerAssetsLoading(false)
      return
    }

    let cancelled = false
    setIsPickerAssetsLoading(true)

    ensureProjectAssets(projectId)
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to load assets for replacement picker:', error)
        toast.error('Failed to load assets for replacement')
      })
      .finally(() => {
        if (!cancelled) {
          setIsPickerAssetsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [assetPickerClip, projectId])

  useEffect(() => {
    if (!assetPickerClip || pickerClipData) return
    closeAssetPicker()
  }, [assetPickerClip, closeAssetPicker, pickerClipData])

  useModalFocusTrap(Boolean(assetPickerClip), pickerRef, closeAssetPicker)

  useEffect(() => {
    return () => {
      closeAssetPicker()
    }
  }, [closeAssetPicker])

  const goToStart  = useCallback(() => { setIsPlaying(false); setPlayheadPosition(0) }, [setIsPlaying, setPlayheadPosition])
  const goToEnd    = useCallback(() => { setIsPlaying(false); setPlayheadPosition(Math.max(0, totalFrames - 1)) }, [setIsPlaying, setPlayheadPosition, totalFrames])
  const togglePlay = useCallback(() => setIsPlaying(!isPlaying), [setIsPlaying, isPlaying])

  const handlePreviewAreaMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!assetPickerClip) return
    if (pickerRef.current && pickerRef.current.contains(event.target as Node)) return
    closeAssetPicker()
  }

  const handleReplaceClipAsset = useCallback((asset: Asset) => {
    if (!assetPickerClip || !pickerClipData || !asset.playback_url) return

    const fallbackDuration = pickerClipData.endFrame - pickerClipData.startFrame + 1
    const durationFrames = asset.duration_seconds
      ? Math.max(1, Math.round(asset.duration_seconds * fps))
      : Math.max(1, fallbackDuration)

    replaceClipAsset(assetPickerClip.trackId, assetPickerClip.clipId, {
      assetUrl: asset.playback_url,
      assetId: asset.id,
      mediaType: asset.file_type,
      label: asset.name,
      durationFrames,
      previewUrl: asset.preview_url ?? undefined,
    })

    closeAssetPicker()
  }, [assetPickerClip, pickerClipData, fps, replaceClipAsset, closeAssetPicker])

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: '#111',
        overflow: 'hidden',
        position: 'relative',
        zIndex: 10,
      }}
    >
      {assetPickerClip && (
        <>
          <div
            onMouseDown={closeAssetPicker}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
              background: 'transparent',
            }}
          />

          <div
            ref={pickerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-picker-title"
            tabIndex={-1}
            style={{
              position: 'fixed',
              top: 86,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 'min(420px, calc(100vw - 32px))',
              background: '#1a1a1a',
              border: '1px solid #2f2f2f',
              borderRadius: 10,
              boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
              zIndex: 50,
              overflow: 'hidden',
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div
              style={{
                padding: '10px 12px',
                borderBottom: '1px solid #2a2a2a',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span
                id="asset-picker-title"
                style={{ fontSize: 11, fontWeight: 700, color: '#b8b8b8', letterSpacing: 0.6 }}
              >
                REPLACE CLIP ASSET
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>
                {pickerClipData?.label ?? 'Selected clip'}
              </span>
              <button
                onClick={closeAssetPicker}
                aria-label="Close asset picker"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#777',
                  cursor: 'pointer',
                  fontSize: 16,
                  lineHeight: 1,
                  padding: '0 2px',
                }}
                title="Close asset picker"
              >
                ×
              </button>
            </div>

            <div style={{ maxHeight: 220, overflowY: 'auto', padding: 8 }}>
              {isPickerAssetsLoading ? (
                <div style={{ padding: '14px 10px', fontSize: 12, color: '#777' }}>Loading assets…</div>
              ) : pickerAssetOptions.length === 0 ? (
                <div style={{ padding: '14px 10px', fontSize: 12, color: '#777' }}>No matching assets available</div>
              ) : (
                pickerAssetOptions.map((asset) => (
                  <button
                    key={asset.id}
                    onClick={() => handleReplaceClipAsset(asset)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 6,
                      border: '1px solid #303030',
                      background: '#202020',
                      color: '#ddd',
                      fontSize: 12,
                      marginBottom: 6,
                      cursor: 'pointer',
                    }}
                  >
                    {asset.name}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Player area ── */}
      {hasComparisonSource && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '10px 16px 0',
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setComparisonMode((enabled) => !enabled)}
            aria-pressed={comparisonMode}
            style={{
              borderRadius: 6,
              border: comparisonMode ? '1px solid rgba(99,160,255,0.6)' : '1px solid #3a3a3a',
              background: comparisonMode ? 'rgba(99,160,255,0.16)' : '#1f1f1f',
              color: comparisonMode ? '#63a0ff' : '#bbb',
              fontSize: 11,
              fontFamily: 'monospace',
              padding: '5px 10px',
              cursor: 'pointer',
              letterSpacing: 0.4,
            }}
            title="Toggle comparison split view"
          >
            {comparisonMode ? 'COMPARISON ON' : 'COMPARISON OFF'}
          </button>
        </div>
      )}

      <div
        onMouseDown={handlePreviewAreaMouseDown}
        style={{
          flex: 1,
          display: 'flex',
          gap: isSplit ? 12 : 0,
          padding: isSplit ? '12px 12px 0' : '12px 16px 0',
          overflow: 'hidden',
          transition: 'gap 0.2s',
        }}
      >
        {/* Original (always visible) */}
        <PlayerSlot
          playerRef={mainRef}
          tracks={compositionTree}
          totalFrames={totalFrames}
          fps={fps}
          label="ORIGINAL"
          isProposed={false}
        />

        {/* AI Preview (only when proposedComposition is set) */}
        {isSplit && (
          <PlayerSlot
            playerRef={proposedRef}
            tracks={proposedComposition!}
            totalFrames={proposedMeta?.totalFrames ?? totalFrames}
            fps={proposedMeta?.fps ?? fps}
            label="AI PREVIEW"
            isProposed
          />
        )}
      </div>

      {/* ── Ghost preview accept/reject bar ── */}
      <GhostPreviewBar />

      <PlayerScrubber
        totalFrames={totalFrames}
        fps={fps}
        isPlaying={isPlaying}
        onTogglePlay={togglePlay}
        onGoToStart={goToStart}
        onGoToEnd={goToEnd}
      />
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: '#2a2a2a', border: '1px solid #3a3a3a', borderRadius: 6,
  color: '#ccc', cursor: 'pointer', flexShrink: 0,
}
