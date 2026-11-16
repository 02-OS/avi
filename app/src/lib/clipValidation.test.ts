import assert from 'node:assert/strict'
import test from 'node:test'
import type { Clip, Track } from '../store/useEditorStore'
import { getSafeMediaTrimProps, normalizeTimeline, validateClip } from './clipValidation.ts'

test('getSafeMediaTrimProps uses Remotion 4 exclusive end source coordinates', () => {
  const clip: Clip = {
    id: 'clip-1',
    trackId: 'track-1',
    startFrame: 0,
    endFrame: 39,
    label: 'Clip',
    color: '#e94560',
    mediaType: 'video',
    mediaStart: 100,
    mediaEnd: 139,
    mediaDurationFrames: 150,
  }

  assert.equal(validateClip(clip), true)
  const trim = getSafeMediaTrimProps(clip)
  assert.equal(trim.trimBefore, 100)
  assert.equal(trim.trimAfter, 140)
  assert.ok(trim.trimAfter! > trim.trimBefore!)
})

test('getSafeMediaTrimProps omits trimAfter when tail is untrimmed', () => {
  const clip: Clip = {
    id: 'clip-2',
    trackId: 'track-1',
    startFrame: 0,
    endFrame: 49,
    label: 'Clip 2',
    color: '#e94560',
    mediaType: 'video',
    mediaStart: 100,
    mediaEnd: 149,
    mediaDurationFrames: 150,
  }

  const trim = getSafeMediaTrimProps(clip)
  assert.equal(trim.trimBefore, 100)
  assert.equal(trim.trimAfter, undefined)
})

test('normalizeTimeline preserves intentional intro gaps', () => {
  const tracks: Track[] = [
    {
      id: 'track-1',
      name: 'Video 1',
      type: 'video',
      clips: [
        {
          id: 'clip-1',
          trackId: 'track-1',
          startFrame: 30,
          endFrame: 89,
          label: 'Intro Offset',
          color: '#e94560',
        },
      ],
    },
  ]

  const result = normalizeTimeline(tracks)
  assert.equal(result.offsetFrames, 0)
  assert.equal(result.tracks[0]?.clips[0]?.startFrame, 30)
  assert.equal(result.tracks[0]?.clips[0]?.endFrame, 89)
})
