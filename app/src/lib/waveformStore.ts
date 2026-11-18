import { create } from 'zustand'
import { openDB, type IDBPDatabase } from 'idb'

interface WaveformState {
  peaks: Record<string, number[]>
  setPeaks: (assetId: string, peaks: number[]) => void
  removePeaks: (assetId: string) => void
}

export const useWaveformStore = create<WaveformState>((set) => ({
  peaks: {},
  setPeaks: (assetId, peaks) =>
    set((state) => ({
      peaks: {
        ...state.peaks,
        [assetId]: peaks,
      },
    })),
  removePeaks: (assetId) =>
    set((state) => {
      if (!(assetId in state.peaks)) return state
      const { [assetId]: _removed, ...rest } = state.peaks
      return { peaks: rest }
    }),
}))

const PEAK_COUNT = 160
const WAVEFORM_DB_NAME = 'avi-waveform-cache'
const WAVEFORM_STORE_NAME = 'peaks'
const WAVEFORM_DB_VERSION = 1

let waveformDbPromise: Promise<IDBPDatabase> | null = null
let sharedAudioContext: AudioContext | null = null

function getWaveformDB(): Promise<IDBPDatabase> | null {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null
  if (!waveformDbPromise) {
    waveformDbPromise = openDB(WAVEFORM_DB_NAME, WAVEFORM_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(WAVEFORM_STORE_NAME)) {
          db.createObjectStore(WAVEFORM_STORE_NAME)
        }
      },
    }).catch(() => {
      waveformDbPromise = null
      throw new Error('Failed to open waveform cache database')
    })
  }
  return waveformDbPromise
}

function getSharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null

  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new Ctor()
  }
  return sharedAudioContext
}

export async function loadCachedWaveformPeaks(assetId: string): Promise<number[] | null> {
  const existing = useWaveformStore.getState().peaks[assetId]
  if (existing && existing.length > 0) {
    return existing
  }

  try {
    const dbPromise = getWaveformDB()
    if (!dbPromise) return null
    const db = await dbPromise
    const peaks = (await db.get(WAVEFORM_STORE_NAME, assetId)) as number[] | undefined
    if (Array.isArray(peaks) && peaks.length > 0) {
      useWaveformStore.getState().setPeaks(assetId, peaks)
      return peaks
    }
  } catch {
    // Ignore cache read failures
  }
  return null
}

export async function saveCachedWaveformPeaks(assetId: string, peaks: number[]): Promise<void> {
  useWaveformStore.getState().setPeaks(assetId, peaks)
  try {
    const dbPromise = getWaveformDB()
    if (!dbPromise) return
    const db = await dbPromise
    await db.put(WAVEFORM_STORE_NAME, peaks, assetId)
  } catch {
    // Ignore cache write failures
  }
}

export async function deleteCachedWaveformPeaks(assetId: string): Promise<void> {
  useWaveformStore.getState().removePeaks(assetId)
  try {
    const dbPromise = getWaveformDB()
    if (!dbPromise) return
    const db = await dbPromise
    await db.delete(WAVEFORM_STORE_NAME, assetId)
  } catch {
    // Ignore cache delete failures
  }
}

export async function peaksFromAudioBuffer(buffer: AudioBuffer): Promise<number[]> {
  const channel = buffer.getChannelData(0)
  const block = Math.max(1, Math.floor(channel.length / PEAK_COUNT))
  const peaks: number[] = []

  for (let index = 0; index < PEAK_COUNT; index += 1) {
    const start = index * block
    let max = 0
    const end = Math.min(channel.length, start + block)
    for (let sample = start; sample < end; sample += 16) {
      max = Math.max(max, Math.abs(channel[sample] ?? 0))
    }
    peaks.push(Number(max.toFixed(4)))
  }

  return peaks
}

export async function peaksFromArrayBuffer(bytes: ArrayBuffer): Promise<number[] | null> {
  const context = getSharedAudioContext()
  if (!context) return null
  try {
    if (context.state === 'suspended') {
      await context.resume().catch(() => undefined)
    }
    const audio = await context.decodeAudioData(bytes)
    return peaksFromAudioBuffer(audio)
  } catch {
    return null
  }
}
