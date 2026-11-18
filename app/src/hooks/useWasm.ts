import { useState, useEffect } from 'react'
import type {
  alloc_scratch as AllocScratchFn,
  grayscale as GrayscaleFn,
  grayscale_in_place as GrayscaleInPlaceFn,
  invert as InvertFn,
  invert_in_place as InvertInPlaceFn,
  brightness as BrightnessFn,
  brightness_in_place as BrightnessInPlaceFn,
  sepia as SepiaFn,
  sepia_in_place as SepiaInPlaceFn,
  frame_luma_stats as FrameLumaStatsFn,
  frame_luma_stats_in_place as FrameLumaStatsInPlaceFn,
  color_matrix as ColorMatrixFn,
  color_matrix_in_place as ColorMatrixInPlaceFn,
} from '../wasm-pkg/avi_wasm'

// ── Public API surface exposed by the WASM module ────────────────────────────
export interface WasmApi {
  memory: WebAssembly.Memory
  alloc_scratch: typeof AllocScratchFn
  grayscale: typeof GrayscaleFn
  grayscale_in_place: typeof GrayscaleInPlaceFn
  invert: typeof InvertFn
  invert_in_place: typeof InvertInPlaceFn
  brightness: typeof BrightnessFn
  brightness_in_place: typeof BrightnessInPlaceFn
  sepia: typeof SepiaFn
  sepia_in_place: typeof SepiaInPlaceFn
  color_matrix: typeof ColorMatrixFn
  color_matrix_in_place: typeof ColorMatrixInPlaceFn
  frame_luma_stats: typeof FrameLumaStatsFn
  frame_luma_stats_in_place: typeof FrameLumaStatsInPlaceFn
}

export type WasmStatus = 'loading' | 'ready' | 'error'

interface UseWasmReturn {
  status: WasmStatus
  error:  string | null
  api:    WasmApi | null
}

const normalizeWasmError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'string') {
    return new Error(error)
  }

  return new Error('WASM operation failed')
}

const wrapWasmCall = <TArgs extends readonly unknown[], TResult>(
  fn: (...args: TArgs) => TResult
) =>
  ((...args: TArgs): TResult => {
    try {
      return fn(...args)
    } catch (error) {
      throw normalizeWasmError(error)
    }
  })

let cachedWasmApi: WasmApi | null = null
let wasmInitPromise: Promise<WasmApi> | null = null

export const getCachedWasmApi = (): WasmApi | null => cachedWasmApi

export const loadWasmApi = async (): Promise<WasmApi> => {
  if (cachedWasmApi) {
    return cachedWasmApi
  }

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const mod = await import('../wasm-pkg/avi_wasm.js')
      const initOutput = await mod.default()

      if (typeof mod.init_panic_hook === 'function') {
        mod.init_panic_hook()
      }

      cachedWasmApi = {
        memory: initOutput.memory,
        alloc_scratch: wrapWasmCall(mod.alloc_scratch),
        grayscale: wrapWasmCall(mod.grayscale),
        grayscale_in_place: wrapWasmCall(mod.grayscale_in_place),
        invert: wrapWasmCall(mod.invert),
        invert_in_place: wrapWasmCall(mod.invert_in_place),
        brightness: wrapWasmCall(mod.brightness),
        brightness_in_place: wrapWasmCall(mod.brightness_in_place),
        sepia: wrapWasmCall(mod.sepia),
        sepia_in_place: wrapWasmCall(mod.sepia_in_place),
        color_matrix: wrapWasmCall(mod.color_matrix),
        color_matrix_in_place: wrapWasmCall(mod.color_matrix_in_place),
        frame_luma_stats: wrapWasmCall(mod.frame_luma_stats),
        frame_luma_stats_in_place: wrapWasmCall(mod.frame_luma_stats_in_place),
      }

      return cachedWasmApi
    })().catch((error) => {
      wasmInitPromise = null
      throw error
    })
  }

  return wasmInitPromise
}

/**
 * Asynchronously loads and initialises the avi-wasm WebAssembly module.
 * The module is loaded once and cached via ref — safe to call from any component.
 */
export const useWasm = (): UseWasmReturn => {
  const [status, setStatus] = useState<WasmStatus>(cachedWasmApi ? 'ready' : 'loading')
  const [error,  setError]  = useState<string | null>(null)
  const [api, setApi] = useState<WasmApi | null>(cachedWasmApi)

  useEffect(() => {
    if (cachedWasmApi) {
      setApi(cachedWasmApi)
      setStatus('ready')
      setError(null)
      return
    }

    let cancelled = false
    setStatus('loading')
    setError(null)

    ;(async () => {
      try {
        const loadedApi = await loadWasmApi()
        if (!cancelled) {
          setApi(loadedApi)
          setStatus('ready')
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError(normalizeWasmError(e).message)
          setStatus('error')
        }
      }
    })()

    return () => { cancelled = true }
  }, [])

  return { status, error, api }
}
