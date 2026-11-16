import React from 'react'
import { useEditorStore } from '../../store/useEditorStore'
import { PIXELS_PER_FRAME } from './constants'

interface Props {
  totalHeight: number
  pixelsPerFrame?: number
}

export const SelectionOverlay: React.FC<Props> = React.memo(({
  totalHeight,
  pixelsPerFrame = PIXELS_PER_FRAME,
}) => {
  const currentSelection = useEditorStore((s) => s.currentSelection)
  if (!currentSelection) return null

  const { startFrame, endFrame } = currentSelection
  const left  = startFrame * pixelsPerFrame
  const width = Math.max((endFrame - startFrame + 1) * pixelsPerFrame, 2)

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: 0,
        width,
        height: totalHeight,
        background: 'rgba(99, 160, 255, 0.12)',
        borderLeft:  '1.5px solid rgba(99, 160, 255, 0.55)',
        borderRight: '1.5px solid rgba(99, 160, 255, 0.55)',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    />
  )
})
SelectionOverlay.displayName = 'SelectionOverlay'
