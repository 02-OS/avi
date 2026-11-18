import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../store/useEditorStore'
import { sortTracksForRender } from './editorUtils.ts'

test('sortTracksForRender composites audio and video tracks below overlay tracks', () => {
  const tracks: Track[] = [
    { id: 'ov-1', name: 'Overlay 1', type: 'overlay', clips: [] },
    { id: 'vid-1', name: 'Video 1', type: 'video', clips: [] },
    { id: 'aud-1', name: 'Audio 1', type: 'audio', clips: [] },
    { id: 'vid-2', name: 'Video 2', type: 'video', clips: [] },
  ]

  const sorted = sortTracksForRender(tracks)
  assert.deepEqual(
    sorted.map((track) => track.id),
    ['aud-1', 'vid-1', 'vid-2', 'ov-1']
  )
})
