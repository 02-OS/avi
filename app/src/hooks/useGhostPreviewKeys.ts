import { useEffect } from 'react'
import { useEditorStore } from '../store/useEditorStore'
import { isTypingTarget } from '../lib/editorUtils'

/**
 * Global keyboard shortcuts for the ghost preview and history.
 *
 * Enter        → accept proposal  (only when proposal exists AND modals are closed)
 * Esc          → reject proposal  (only when proposal exists AND modals are closed)
 * Cmd/Ctrl+Z   → undo
 * Cmd/Ctrl+⇧Z  → redo
 */
export const useGhostPreviewKeys = (isModalOpen = false) => {
  const proposedComposition = useEditorStore((s) => s.proposedComposition)
  const isPromptOpen        = useEditorStore((s) => s.isPromptOpen)
  const assetPickerClip     = useEditorStore((s) => s.assetPickerClip)
  const acceptProposal      = useEditorStore((s) => s.acceptProposal)
  const rejectProposal      = useEditorStore((s) => s.rejectProposal)
  const undo                = useEditorStore((s) => s.undo)
  const redo                = useEditorStore((s) => s.redo)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isModalOpen || isPromptOpen || assetPickerClip || isTypingTarget(e.target)) {
        return
      }

      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      // ── Accept / Reject (proposal must exist, modals must be closed) ────────
      if (proposedComposition) {
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
          e.preventDefault()
          acceptProposal()
          return
        }
        if (e.key === 'Escape') {
          rejectProposal()
          return
        }
      }

      // ── Undo (⌘Z / Ctrl+Z) ──────────────────────────────────────────────────
      if (mod && !e.shiftKey && key === 'z') {
        e.preventDefault()
        undo()
        return
      }

      // ── Redo (⌘⇧Z / Ctrl+⇧Z / Ctrl+Y) ─────────────────────────────────────
      if ((mod && e.shiftKey && key === 'z') || (mod && !e.shiftKey && key === 'y')) {
        e.preventDefault()
        redo()
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isModalOpen, proposedComposition, isPromptOpen, assetPickerClip, acceptProposal, rejectProposal, undo, redo])
}
