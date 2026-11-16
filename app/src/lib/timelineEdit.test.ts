import assert from 'node:assert/strict'
import test from 'node:test'
import type { Clip } from '../store/useEditorStore'
import { movedClipRange, resolveTrimmedClip, rippleDelete, snapStart } from './timelineEdit.ts'

const clip = (id: string, startFrame: number, endFrame: number): Clip => ({
  id,
  trackId: 'track-1',
  startFrame,
  endFrame,
  label: id,
  color: '#fff',
})

test('movedClipRange keeps the clip duration', () => {
  assert.deepEqual(movedClipRange(10, 19, 40), { startFrame: 40, endFrame: 49 })
  assert.deepEqual(movedClipRange(10, 19, -4), { startFrame: 0, endFrame: 9 })
})

test('snapStart pulls the nearest edge inside the threshold', () => {
  assert.equal(snapStart(12, 10, [0, 10, 100], 8), 10)
  assert.equal(snapStart(92, 10, [100], 8), 90)
  assert.equal(snapStart(40, 10, [0], 8), 40)
})

test('rippleDelete closes the gap after the removed clip', () => {
  const clips = [clip('a', 0, 9), clip('b', 10, 19), clip('c', 30, 34)]
  const next = rippleDelete(clips, 'b')
  assert.deepEqual(
    next.map((item) => [item.id, item.startFrame, item.endFrame]),
    [
      ['a', 0, 9],
      ['c', 20, 24],
    ]
  )
})

test('resolveTrimmedClip clamps right-edge drag without moving startFrame backward', () => {
  const mediaClip: Clip = {
    id: 'm1',
    trackId: 'track-1',
    startFrame: 20,
    endFrame: 49,
    label: 'Media',
    color: '#e94560',
    mediaType: 'video',
    mediaStart: 10,
    mediaEnd: 39,
    mediaDurationFrames: 60,
  }

  // Dragging right edge left past startFrame must clamp endFrame to startFrame, not drag startFrame left.
  const clampedLeft = resolveTrimmedClip(mediaClip, 20, 5, 'right')
  assert.equal(clampedLeft.startFrame, 20)
  assert.equal(clampedLeft.endFrame, 20)
  assert.equal(clampedLeft.mediaStart, 10)
  assert.equal(clampedLeft.mediaEnd, 10)

  // Dragging right edge past current endFrame extends within mediaDurationFrames.
  const extendedRight = resolveTrimmedClip(mediaClip, 20, 90, 'right')
  assert.equal(extendedRight.startFrame, 20)
  assert.equal(extendedRight.endFrame, 69)
  assert.equal(extendedRight.mediaEnd, 59)
})
