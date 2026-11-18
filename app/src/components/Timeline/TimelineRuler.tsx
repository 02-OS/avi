import React, { useMemo } from 'react'
import { PIXELS_PER_FRAME, RULER_HEIGHT } from './constants'

interface Props {
  totalFrames: number
  pixelsPerFrame?: number
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void
}

export const TimelineRuler: React.FC<Props> = React.memo(({
  totalFrames,
  pixelsPerFrame = PIXELS_PER_FRAME,
  onMouseDown,
}) => {
  const ticks = useMemo(() => {
    const step = pixelsPerFrame < 2.5 ? 30 : 10
    const majorEvery = pixelsPerFrame < 2.5 ? 60 : 30
    const items: React.ReactNode[] = []

    for (let f = 0; f <= totalFrames; f += step) {
      const x = f * pixelsPerFrame
      const isMajor = f % majorEvery === 0

      items.push(
        <React.Fragment key={f}>
          <div
            style={{
              position: 'absolute',
              left: x,
              bottom: 0,
              width: 1,
              height: isMajor ? 14 : 8,
              background: isMajor ? '#555' : '#333',
            }}
          />
          {isMajor && (
            <span
              style={{
                position: 'absolute',
                left: x + 3,
                top: 5,
                fontSize: 10,
                color: '#777',
                fontFamily: 'monospace',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {f}
            </span>
          )}
        </React.Fragment>
      )
    }

    return items
  }, [totalFrames, pixelsPerFrame])

  return (
    <div
      data-ruler="timeline"
      onMouseDown={onMouseDown}
      style={{
        height: RULER_HEIGHT,
        background: '#181818',
        borderBottom: '1px solid #2e2e2e',
        position: 'relative',
        userSelect: 'none',
        flexShrink: 0,
        cursor: 'ew-resize',
      }}
    >
      {ticks}
    </div>
  )
})
TimelineRuler.displayName = 'TimelineRuler'
