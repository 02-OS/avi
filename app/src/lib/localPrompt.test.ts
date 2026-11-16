import assert from 'node:assert/strict'
import test from 'node:test'
import { applyLocalPrompt } from './localPrompt.ts'
import type { Track } from '../store/useEditorStore'

const tracks = (): Track[] => [
  {
    id: 'video-1',
    name: 'Video 1',
    type: 'video',
    clips: [
      {
        id: 'clip-1',
        trackId: 'video-1',
        startFrame: 0,
        endFrame: 29,
        label: 'Interview',
        color: '#e94560',
        mediaType: 'video',
        mediaStart: 0,
        mediaEnd: 29,
        mediaDurationFrames: 40,
      },
    ],
  },
]

test('local prompt applies a pixel filter without dropping the clip', () => {
  const result = applyLocalPrompt({
    prompt: 'make it grayscale',
    frameRange: null,
    tracks: tracks(),
    totalFrames: 30,
    fps: 30,
  })

  assert.equal(result.tracks[0]?.clips[0]?.pixelFilter, 'grayscale')
  assert.equal(result.tracks[0]?.clips[0]?.id, 'clip-1')
  assert.match(result.explanation, /grayscale/)
})

test('local prompt splits a clip into two source ranges', () => {
  const result = applyLocalPrompt({
    prompt: 'split this clip',
    frameRange: null,
    tracks: tracks(),
    totalFrames: 30,
    fps: 30,
  })

  const clips = result.tracks[0]?.clips ?? []
  assert.equal(clips.length, 2)
  assert.equal(clips[0]?.endFrame, 14)
  assert.equal(clips[1]?.startFrame, 15)
  assert.equal(clips[1]?.mediaStart, 15)
})

test('local prompt adds a text overlay', () => {
  const result = applyLocalPrompt({
    prompt: 'add title "Cold open"',
    frameRange: null,
    tracks: tracks(),
    totalFrames: 30,
    fps: 30,
  })

  const overlay = result.tracks.find((track) => track.type === 'overlay')
  assert.equal(overlay?.clips[0]?.text, 'Cold open')
  assert.equal(overlay?.clips[0]?.mediaType, 'text')
})

test('local prompt uses word boundaries so "credits" does not trigger "red"', () => {
  const result = applyLocalPrompt({
    prompt: 'add title "End credits"',
    frameRange: null,
    tracks: tracks(),
    totalFrames: 30,
    fps: 30,
  })

  assert.equal(result.tracks[0]?.clips[0]?.color, '#e94560')
})

test('local prompt clamps shorter sub-5-frame clips and bounded extend', () => {
  const shortTracks: Track[] = [
    {
      id: 'video-1',
      name: 'Video 1',
      type: 'video',
      clips: [
        {
          id: 'short-1',
          trackId: 'video-1',
          startFrame: 10,
          endFrame: 12,
          label: 'Tiny',
          color: '#e94560',
          mediaType: 'video',
          mediaStart: 0,
          mediaEnd: 2,
          mediaDurationFrames: 10,
        },
      ],
    },
  ]

  const shortened = applyLocalPrompt({
    prompt: 'make it shorter by 1 frames',
    frameRange: null,
    tracks: shortTracks,
    totalFrames: 30,
    fps: 30,
  })
  assert.equal(shortened.tracks[0]?.clips[0]?.endFrame, 11)

  const extended = applyLocalPrompt({
    prompt: 'extend by 50 frames',
    frameRange: null,
    tracks: shortTracks,
    totalFrames: 30,
    fps: 30,
  })
  assert.equal(extended.tracks[0]?.clips[0]?.endFrame, 19)
  assert.equal(extended.tracks[0]?.clips[0]?.mediaEnd, 9)
})
