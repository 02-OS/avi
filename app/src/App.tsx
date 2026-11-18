import React, { useRef, useState } from 'react'
import { PlayerPanel }  from './components/PlayerPanel/PlayerPanel'
import { PreviewErrorBoundary } from './components/PlayerPanel/PreviewErrorBoundary'
import { Timeline }     from './components/Timeline/Timeline'
import { PromptModal }  from './components/PromptModal/PromptModal'
import { WasmPanel }    from './components/WasmPanel/WasmPanel'
import { AuthModal }    from './components/AuthModal/AuthModal'
import { AssetLibrary }  from './components/AssetLibrary/AssetLibrary'
import { UploadFirstCanvas } from './components/UploadFirstCanvas/UploadFirstCanvas'
import { ToastContainer } from './components/ToastContainer/ToastContainer'
import { ProjectSwitcherModal } from './components/ProjectSwitcherModal/ProjectSwitcherModal'
import { Spinner } from './components/Spinner/Spinner'
import { useCommandK }        from './hooks/useCommandK'
import { useGhostPreviewKeys } from './hooks/useGhostPreviewKeys'
import { useProjectManager } from './hooks/useProjectManager'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { useTimelineShortcuts } from './hooks/useTimelineShortcuts'
import { useDesktopFileDrop } from './hooks/useDesktopFileDrop'
import { useModalFocusTrap } from './hooks/useModalFocusTrap'
import { useAuth } from './lib/authContext'
import { useAssetStore } from './lib/assetService'
import {
  exportTimelineNative,
  extractLocalPathFromDesktopMediaUrl,
  ffmpegAvailable,
  isDesktopApp,
  pickExportPath,
  saveExportFile,
  type NativeExportClipInput,
} from './lib/desktop'
import { writeLocalProject } from './lib/localProject'
import { useEditorStore }      from './store/useEditorStore'
import { toast } from './lib/toastStore'
import { EXPORT_PRESETS, exportEditedVideo, type ExportPresetName } from './lib/videoExportService'
import { hasMissingRenderableMedia, hasUsableVideoClips, sortTracksForRender } from './lib/editorUtils'

const buildDefaultExportFilename = (ext: 'mp4' | 'webm') => {
  const now = new Date()
  return `avi-export-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.${ext}`
}

const App: React.FC = () => {
  const { user, loading: authLoading, signOut } = useAuth()
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showAssets, setShowAssets] = useState(true)
  const [showWasmPanel, setShowWasmPanel] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportPreset, setExportPreset] = useState<ExportPresetName>('720p')
  const [showAuth, setShowAuth] = useState(false)
  const shortcutsModalRef = useRef<HTMLDivElement>(null)
  const isOnline = useOnlineStatus()

  const {
    projectId,
    projectName,
    projectStatus,
    projectError,
    retryProjectInit,
    forceSave,
    hasUnsavedChanges,
    switchProject,
    createNewCloudProject,
    renameProjectById,
    deleteProjectById,
  } = useProjectManager()

  const isAnyAppModalOpen = (showAuth && !user) || showShortcuts || showProjects

  useCommandK()
  useGhostPreviewKeys(isAnyAppModalOpen)
  useTimelineShortcuts(isAnyAppModalOpen)
  useDesktopFileDrop(projectId)
  useModalFocusTrap(showShortcuts, shortcutsModalRef, () => setShowShortcuts(false))

  const compositionTree = useEditorStore((s) => s.compositionTree)
  const proposedComposition = useEditorStore((s) => s.proposedComposition)
  const totalFrames = useEditorStore((s) => s.totalFrames)
  const fps = useEditorStore((s) => s.fps)
  const historyIndex = useEditorStore((s) => s.historyIndex)
  const historyLen = useEditorStore((s) => s.history.length)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const canUndo = historyIndex > 0
  const canRedo = historyIndex < historyLen - 1
  const hasPrimaryVideo = hasUsableVideoClips(compositionTree)
  const hasMissingMedia = hasMissingRenderableMedia(compositionTree)
  const isUploadFirst = !hasPrimaryVideo

  const handleExport = async () => {
    if (!hasPrimaryVideo) {
      toast.info('Upload and place a video on the timeline before exporting.')
      return
    }

    if (proposedComposition) {
      toast.info('Accept or reject the AI preview before exporting.')
      return
    }

    if (hasMissingMedia) {
      toast.error('Export is blocked because some media files are missing locally.')
      return
    }

    setExporting(true)
    setExportProgress(0)

    try {
      // On desktop with FFmpeg installed, prefer native offline MP4 rendering when all media files are local.
      if (isDesktopApp() && (await ffmpegAvailable())) {
        const assetLocalPaths = new Map(
          useAssetStore
            .getState()
            .assets.filter((asset) => Boolean(asset.local_path))
            .map((asset) => [asset.id, asset.local_path as string])
        )

        const orderedTracks = sortTracksForRender(compositionTree)
        const nativeClips: NativeExportClipInput[] = []
        let allSourcesLocal = true

        for (const track of orderedTracks) {
          for (const clip of track.clips) {
            if (clip.isMissingAsset) continue
            if (clip.mediaType === 'text') {
              nativeClips.push({
                id: clip.id,
                trackType: track.type,
                trackMuted: Boolean(track.muted),
                startFrame: clip.startFrame,
                endFrame: clip.endFrame,
                mediaType: 'text',
                opacity: clip.opacity,
                text: clip.text,
                fontSize: clip.fontSize,
                fontColor: clip.fontColor,
              })
              continue
            }

            if (!clip.mediaType || !clip.assetUrl) continue
            const localPath =
              (clip.assetId ? assetLocalPaths.get(clip.assetId) : undefined) ??
              extractLocalPathFromDesktopMediaUrl(clip.assetUrl)

            if (!localPath) {
              allSourcesLocal = false
              break
            }

            nativeClips.push({
              id: clip.id,
              trackType: track.type,
              trackMuted: Boolean(track.muted),
              startFrame: clip.startFrame,
              endFrame: clip.endFrame,
              mediaType: clip.mediaType,
              sourcePath: localPath,
              mediaStart: clip.mediaStart,
              mediaEnd: clip.mediaEnd,
              opacity: clip.opacity,
              pixelFilter: clip.pixelFilter,
            })
          }
          if (!allSourcesLocal) break
        }

        if (allSourcesLocal && nativeClips.length > 0) {
          const outputPath = await pickExportPath(buildDefaultExportFilename('mp4'))
          if (!outputPath) {
            toast.info('Export cancelled')
            return
          }
          toast.info('Rendering video with FFmpeg...')
          const { width, height } = EXPORT_PRESETS[exportPreset]
          await exportTimelineNative({
            outputPath,
            width,
            height,
            fps,
            totalFrames,
            clips: nativeClips,
          })
          toast.success('Edited video exported.')
          return
        }
      }

      toast.info('Preparing your edited video for download...')
      const { blob, filename } = await exportEditedVideo({
        tracks: compositionTree,
        totalFrames,
        fps,
        preset: exportPreset,
        onProgress: setExportProgress,
      })

      const outcome = await saveExportFile(filename, blob)
      if (outcome === 'cancelled') {
        toast.info('Export cancelled')
      } else if (outcome === 'saved') {
        toast.success('Edited video saved.')
      } else {
        toast.success('Edited video downloaded successfully.')
      }
    } catch (error) {
      console.error('Export failed:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to export the edited video')
    } finally {
      setExporting(false)
      setExportProgress(0)
    }
  }

  const handleSave = async () => {
    toast.info('Saving project...')
    try {
      await forceSave()
      toast.success('Project saved!')
    } catch (err) {
      toast.error('Save failed. Please try again.')
      console.error('Save error:', err)
    }
  }

  const handleSignOut = async () => {
    writeLocalProject({ tracks: compositionTree, totalFrames, fps })
    if (user && hasUnsavedChanges) {
      try {
        await forceSave()
      } catch (error) {
        console.error('Cloud save failed before sign out', error)
        const confirmed = window.confirm('Cloud save failed. Sign out and keep the local copy?')
        if (!confirmed) return
      }
    }
    await signOut()
    setShowAuth(false)
  }

  if (authLoading) {
    return (
      <div style={{
        height: '100vh',
        background: '#0f0f0f',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: '#e94560', marginBottom: 20 }}>
            avi
          </div>
          <Spinner size="large" text="Initializing your workspace..." />
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#0f0f0f',
        overflow: 'hidden',
      }}
    >
      {/* ── App header ── */}
      <header
        style={{
          height: 52,
          background: 'linear-gradient(180deg, #1a1a1a 0%, #151515 100%)',
          borderBottom: '1px solid #2a2a2a',
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          gap: 16,
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18, color: '#e94560' }} aria-hidden="true">✦</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: '#fff', letterSpacing: 0.5 }}>
            avi
          </span>
          <div style={{
            width: 1,
            height: 20,
            background: '#2a2a2a',
            margin: '0 8px',
          }} />
          <span style={{ fontSize: 11, color: '#666', fontWeight: 500 }}>
            AI Video Editor
          </span>
        </div>

        {!isUploadFirst && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 16 }}>
            <button
              onClick={() => setShowAssets(!showAssets)}
              aria-pressed={showAssets}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: showAssets ? '#e94560' : '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: showAssets ? '#fff' : '#aaa',
                fontSize: 12,
                padding: '6px 12px',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              <span aria-hidden="true">📂</span>
              Assets
            </button>
            <button
              onClick={() => void handleSave()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: hasUnsavedChanges ? '#252525' : '#1f1f1f',
                border: hasUnsavedChanges ? '1px solid #333' : '1px solid #2a2a2a',
                borderRadius: 6,
                color: hasUnsavedChanges ? '#aaa' : '#666',
                fontSize: 12,
                padding: '6px 12px',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              <span aria-hidden="true">💾</span>
              {hasUnsavedChanges ? 'Save •' : 'Saved'}
            </button>
            <select
              aria-label="Export quality"
              value={exportPreset}
              onChange={(event) => setExportPreset(event.target.value as ExportPresetName)}
              disabled={exporting}
              style={{
                background: '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#aaa',
                fontSize: 12,
                padding: '6px 8px',
              }}
            >
              {(Object.keys(EXPORT_PRESETS) as ExportPresetName[]).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void handleExport()}
              disabled={exporting || hasMissingMedia || Boolean(proposedComposition)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: exporting ? '#1a6cf0' : '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: exporting ? '#fff' : '#aaa',
                fontSize: 12,
                padding: '6px 12px',
                cursor: exporting || hasMissingMedia || Boolean(proposedComposition) ? 'not-allowed' : 'pointer',
                opacity: exporting || hasMissingMedia || Boolean(proposedComposition) ? 0.7 : 1,
                transition: 'all 0.2s',
              }}
              title={
                proposedComposition
                  ? 'Accept or reject the AI preview before exporting'
                  : hasMissingMedia
                    ? 'Missing local media blocks export'
                    : 'Export edited video'
              }
            >
              <span aria-hidden="true">⬇</span>
              {exporting ? (exportProgress > 0 ? `Exporting ${exportProgress}%` : 'Exporting...') : 'Export'}
            </button>
            <button
              onClick={undo}
              disabled={!canUndo}
              aria-label="Undo"
              title="Undo (⌘Z)"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#aaa',
                fontSize: 12,
                padding: '6px 12px',
                cursor: canUndo ? 'pointer' : 'not-allowed',
                opacity: canUndo ? 1 : 0.4,
                transition: 'all 0.2s',
              }}
            >
              <span aria-hidden="true">↩</span>
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo (⌘⇧Z)"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#aaa',
                fontSize: 12,
                padding: '6px 12px',
                cursor: canRedo ? 'pointer' : 'not-allowed',
                opacity: canRedo ? 1 : 0.4,
                transition: 'all 0.2s',
              }}
            >
              <span aria-hidden="true">↪</span>
            </button>
            <button
              onClick={() => setShowWasmPanel((visible) => !visible)}
              aria-pressed={showWasmPanel}
              title="Toggle WASM filter benchmark panel"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: showWasmPanel ? 'rgba(99, 160, 255, 0.16)' : '#252525',
                border: showWasmPanel ? '1px solid rgba(99, 160, 255, 0.5)' : '1px solid #333',
                borderRadius: 6,
                color: showWasmPanel ? '#63a0ff' : '#888',
                fontSize: 11,
                fontFamily: 'monospace',
                padding: '6px 10px',
                cursor: 'pointer',
              }}
            >
              ⬡ WASM
            </button>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Project switcher button */}
        {projectId && (
          <button
            onClick={() => setShowProjects(true)}
            title="Switch or manage projects"
            aria-label={`Projects (${projectName})`}
            style={{
              fontSize: 11,
              color: hasUnsavedChanges ? '#f59e0b' : '#aaa',
              background: '#1a1a1a',
              border: '1px solid #2e2e2e',
              padding: '4px 10px',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              cursor: 'pointer',
            }}
          >
            {hasUnsavedChanges && <span style={{ fontSize: 8 }} aria-hidden="true">●</span>}
            <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {projectName}
            </span>
            <span style={{ fontSize: 10, color: '#555', fontFamily: 'monospace' }}>
              {projectId.slice(0, 8)}
            </span>
          </button>
        )}

        {/* Offline indicator */}
        {!isOnline && (
          <div style={{
            fontSize: 11,
            color: '#f59e0b',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            padding: '4px 10px',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <span aria-hidden="true">⚠</span>
            Offline
          </div>
        )}

        {/* User info and actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            aria-label="Keyboard shortcuts"
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: 16,
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 4,
            }}
            title="Keyboard Shortcuts"
          >
            ⌨
          </button>

          <div
            aria-hidden="true"
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #e94560 0%, #1a6cf0 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            {user?.email?.charAt(0).toUpperCase() || 'U'}
          </div>

          {user ? (
            <button
              onClick={() => void handleSignOut()}
              style={{
                background: '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#888',
                fontSize: 12,
                padding: '6px 12px',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              Sign Out
            </button>
          ) : (
            <button
              onClick={() => setShowAuth(true)}
              style={{
                background: '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#ccc',
                fontSize: 12,
                padding: '6px 12px',
                cursor: 'pointer',
              }}
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      {!isUploadFirst ? (
        <>
          {showWasmPanel && <WasmPanel />}

          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {showAssets && (
              <div style={{ width: 260, flexShrink: 0, overflow: 'hidden' }}>
                <AssetLibrary projectId={projectId} />
              </div>
            )}
            <PreviewErrorBoundary>
              <PlayerPanel projectId={projectId} />
            </PreviewErrorBoundary>
          </div>

          <div style={{ height: 230, flexShrink: 0, position: 'relative', zIndex: 20 }}>
            <Timeline />
          </div>
        </>
      ) : (
        <UploadFirstCanvas
          projectId={projectId}
          projectStatus={projectStatus}
          projectError={projectError}
          onRetry={retryProjectInit}
        />
      )}

      {/* ── Modals ── */}
      {showAuth && !user && <AuthModal onClose={() => setShowAuth(false)} />}

      <ProjectSwitcherModal
        isOpen={showProjects}
        isSignedIn={Boolean(user)}
        currentProjectId={projectId}
        onClose={() => setShowProjects(false)}
        onOpenAuth={() => setShowAuth(true)}
        onSelectProject={switchProject}
        onCreateProject={createNewCloudProject}
        onRenameProject={renameProjectById}
        onDeleteProject={deleteProjectById}
      />

      <PromptModal />

      {/* ── Keyboard Shortcuts Modal ── */}
      {showShortcuts && (
        <>
          <div
            onClick={() => setShowShortcuts(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.7)',
              backdropFilter: 'blur(4px)',
              zIndex: 40,
            }}
          />
          <div
            ref={shortcutsModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-modal-title"
            tabIndex={-1}
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: '#1a1a1a',
              border: '1px solid #2a2a2a',
              borderRadius: 12,
              padding: '24px',
              minWidth: 320,
              zIndex: 50,
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
            }}
          >
            <h3
              id="shortcuts-modal-title"
              style={{
                margin: '0 0 16px 0',
                fontSize: 16,
                fontWeight: 700,
                color: '#fff',
              }}
            >
              Keyboard Shortcuts
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { keys: '⌘K / Ctrl+K', action: 'Open AI Prompt' },
                { keys: '⌘Z / Ctrl+Z', action: 'Undo' },
                { keys: '⌘Y / Ctrl+Shift+Z', action: 'Redo' },
                { keys: 'Enter', action: 'Accept AI Proposal' },
                { keys: 'Esc', action: 'Reject AI Proposal / Close Modal' },
                { keys: 'Export', action: 'Download current edited video' },
                { keys: 'S', action: 'Split selected clip at playhead' },
                { keys: 'D', action: 'Duplicate selected clip' },
                { keys: 'Delete', action: 'Delete selected clip' },
                { keys: 'Shift+Delete', action: 'Ripple delete selected clip' },
                { keys: '← / →', action: 'Nudge selected clip by 1 frame' },
                { keys: 'Shift+← / →', action: 'Nudge selected clip by 5 frames' },
                { keys: 'Space', action: 'Play/Pause' },
              ].map(({ keys, action }) => (
                <div key={keys} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid #2a2a2a',
                }}>
                  <span style={{ color: '#aaa', fontSize: 13 }}>{action}</span>
                  <kbd style={{
                    background: '#252525',
                    border: '1px solid #333',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: '#888',
                  }}>
                    {keys}
                  </kbd>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowShortcuts(false)}
              style={{
                marginTop: 16,
                width: '100%',
                padding: '10px',
                background: '#252525',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#fff',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Got it!
            </button>
          </div>
        </>
      )}

      {/* ── Toast notifications ── */}
      <ToastContainer />
    </div>
  )
}

export default App
