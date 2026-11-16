import assert from 'node:assert/strict'
import test from 'node:test'
import { createAutoSave } from './autoSave.ts'

test('createAutoSave retains pendingSave on failure and flushes outcome accurately', async () => {
  const autoSave = createAutoSave(50)
  let shouldFail = true
  let attempts = 0

  autoSave.schedule(async () => {
    attempts += 1
    if (shouldFail) {
      throw new Error('network error')
    }
  })

  const firstOutcome = await autoSave.flush()
  assert.equal(firstOutcome, false)
  assert.equal(attempts, 1)

  shouldFail = false
  const retryOutcome = await autoSave.flush()
  assert.equal(retryOutcome, true)
  assert.equal(attempts, 2)

  // Already flushed, subsequent flush returns true without re-running.
  const idleOutcome = await autoSave.flush()
  assert.equal(idleOutcome, true)
  assert.equal(attempts, 2)
})

test('createAutoSave does not clobber newer pendingSave and cancel clears pending work', async () => {
  const autoSave = createAutoSave(100)
  const calls: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  autoSave.schedule(async () => {
    calls.push('first-start')
    await firstGate
    calls.push('first-end')
  })

  const firstFlush = autoSave.flush()
  // Schedule a newer save while the first save is still in flight.
  autoSave.schedule(async () => {
    calls.push('second')
  })

  releaseFirst()
  await firstFlush

  const secondFlush = await autoSave.flush()
  assert.equal(secondFlush, true)
  assert.deepEqual(calls, ['first-start', 'first-end', 'second'])

  autoSave.schedule(async () => {
    calls.push('cancelled')
  })
  autoSave.cancel()
  await autoSave.flush()
  assert.deepEqual(calls, ['first-start', 'first-end', 'second'])
})
