// Auto-save helper (debounced save)
export function createAutoSave(debounceMs: number = 3000) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let pendingSave: (() => Promise<void>) | null = null
  let activeRun: Promise<boolean> | null = null

  const runPending = async (): Promise<boolean> => {
    if (activeRun) {
      await activeRun
    }

    if (!pendingSave) {
      return true
    }

    const saveFn = pendingSave
    let run: Promise<boolean> | null = null
    run = (async () => {
      try {
        await saveFn()
        if (pendingSave === saveFn) {
          pendingSave = null
        }
        return true
      } catch (error) {
        console.error('Auto-save failed:', error)
        return false
      } finally {
        if (activeRun === run) {
          activeRun = null
        }
      }
    })()

    activeRun = run
    return run
  }

  return {
    schedule: (saveFn: () => Promise<void>) => {
      pendingSave = saveFn

      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      timeoutId = setTimeout(() => {
        timeoutId = null
        void runPending()
      }, debounceMs)
    },

    flush: async (): Promise<boolean> => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      return runPending()
    },

    cancel: () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      pendingSave = null
    },
  }
}
