import React, { useMemo } from 'react'
import { type Clip, useEditorStore } from '../../store/useEditorStore'

function clipsDiffer(a: Clip, b: Clip): boolean {
  return (
    a.trackId !== b.trackId ||
    a.startFrame !== b.startFrame ||
    a.endFrame !== b.endFrame ||
    a.label !== b.label ||
    a.color !== b.color ||
    a.assetId !== b.assetId ||
    a.mediaType !== b.mediaType ||
    a.mediaStart !== b.mediaStart ||
    a.mediaEnd !== b.mediaEnd ||
    a.opacity !== b.opacity ||
    a.pixelFilter !== b.pixelFilter ||
    a.text !== b.text ||
    a.fontSize !== b.fontSize ||
    a.fontColor !== b.fontColor
  )
}

export const GhostPreviewBar: React.FC = () => {
  const compositionTree     = useEditorStore((s) => s.compositionTree)
  const proposedComposition = useEditorStore((s) => s.proposedComposition)
  const historyIndex        = useEditorStore((s) => s.historyIndex)
  const historyLen          = useEditorStore((s) => s.history.length)
  const acceptProposal      = useEditorStore((s) => s.acceptProposal)
  const rejectProposal      = useEditorStore((s) => s.rejectProposal)
  const undo                = useEditorStore((s) => s.undo)
  const redo                = useEditorStore((s) => s.redo)

  // Compute which clips actually changed, were added, or were removed vs original
  const diff = useMemo(() => {
    if (!proposedComposition) return null
    const orig     = compositionTree.flatMap((t) => t.clips)
    const proposed = proposedComposition.flatMap((t) => t.clips)

    const origById = new Map(orig.map((c) => [c.id, c]))
    const proposedById = new Map(proposed.map((c) => [c.id, c]))

    const changed = proposed.filter((pc) => {
      const oc = origById.get(pc.id)
      return !oc || clipsDiffer(oc, pc)
    })
    const removed = orig.filter((oc) => !proposedById.has(oc.id))

    return {
      count: changed.length + removed.length,
      removedCount: removed.length,
      clips: changed,
    }
  }, [compositionTree, proposedComposition])

  const canUndo = historyIndex > 0
  const canRedo = historyIndex < historyLen - 1

  return (
    <div
      style={{
        background: '#141414',
        borderTop:    '1px solid #2a2a2a',
        borderBottom: '1px solid #2a2a2a',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
      }}
    >
      {/* ── Proposal section ── */}
      {proposedComposition && diff ? (
        <>
          {/* Pulse dot */}
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#63a0ff',
              flexShrink: 0,
              boxShadow: '0 0 6px #63a0ff',
              animation: 'pulse 1.4s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: 12, color: '#aaa' }}>
            <span style={{ color: '#63a0ff', fontWeight: 700 }}>
              {diff.count} clip{diff.count !== 1 ? 's' : ''}
            </span>
            {' '}
            {diff.removedCount > 0 ? `changed (${diff.removedCount} removed)` : 'modified'} — review the split-screen preview
          </span>

          <button onClick={acceptProposal} style={{ ...btnBase, background: '#059669', marginLeft: 'auto' }}>
            Accept <kbd style={kbdStyle}>↵</kbd>
          </button>
          <button onClick={rejectProposal} style={{ ...btnBase, background: '#333', color: '#e94560', border: '1px solid #e9456040' }}>
            Reject <kbd style={kbdStyle}>Esc</kbd>
          </button>
        </>
      ) : (
        <span style={{ fontSize: 11, color: '#444', fontFamily: 'monospace' }}>
          No pending changes
        </span>
      )}

      {/* ── Undo / Redo (always visible) ── */}
      <div style={{ display: 'flex', gap: 6, marginLeft: proposedComposition ? 0 : 'auto' }}>
        <button
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (⌘Z)"
          style={{ ...btnBase, opacity: canUndo ? 1 : 0.3, cursor: canUndo ? 'pointer' : 'not-allowed' }}
        >
          ↩ <kbd style={kbdStyle}>⌘Z</kbd>
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (⌘⇧Z)"
          style={{ ...btnBase, opacity: canRedo ? 1 : 0.3, cursor: canRedo ? 'pointer' : 'not-allowed' }}
        >
          ↪ <kbd style={kbdStyle}>⌘⇧Z</kbd>
        </button>
        <span style={{ fontSize: 10, color: '#333', fontFamily: 'monospace', alignSelf: 'center', paddingLeft: 4 }}>
          {historyIndex + 1}/{historyLen}
        </span>
      </div>
    </div>
  )
}

const btnBase: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#fff',
  background: '#252525',
  border: '1px solid #333',
  borderRadius: 6,
  padding: '5px 12px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
}

const kbdStyle: React.CSSProperties = {
  fontSize: 9,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 3,
  padding: '1px 4px',
  fontFamily: 'monospace',
  color: '#aaa',
}
