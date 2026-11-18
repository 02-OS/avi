import { getCachedWasmApi, loadWasmApi, type WasmApi } from '../hooks/useWasm'

export const PIXEL_FILTERS = ['grayscale', 'sepia', 'invert', 'brightness', 'warm'] as const

export type PixelFilterName = (typeof PIXEL_FILTERS)[number]

const WARM_MATRIX = new Float32Array([
  1.08, 0, 0, 0, 0.02,
  0, 1, 0, 0, 0,
  0, 0, 0.9, 0, 0,
  0, 0, 0, 1, 0,
])

export function cssFilterFor(filter: PixelFilterName): string {
  switch (filter) {
    case 'grayscale':
      return 'grayscale(1)'
    case 'sepia':
      return 'sepia(1)'
    case 'invert':
      return 'invert(1)'
    case 'brightness':
      return 'brightness(1.5)'
    case 'warm':
      return 'sepia(0.25) saturate(1.15)'
  }
}

export function isPixelFilter(value: string): value is PixelFilterName {
  return (PIXEL_FILTERS as readonly string[]).includes(value)
}

function runScratchFilter(api: WasmApi, byteLen: number, filter: PixelFilterName): void {
  switch (filter) {
    case 'grayscale':
      api.grayscale_in_place(byteLen)
      break
    case 'sepia':
      api.sepia_in_place(byteLen)
      break
    case 'invert':
      api.invert_in_place(byteLen)
      break
    case 'brightness':
      api.brightness_in_place(byteLen, 1.5)
      break
    case 'warm':
      api.color_matrix_in_place(byteLen, WARM_MATRIX)
      break
  }
}

export function applyPixelFilterInPlaceSync(
  api: WasmApi,
  pixels: Uint8ClampedArray | Uint8Array,
  filter: PixelFilterName
): void {
  const byteLen = pixels.byteLength
  if (byteLen === 0) return

  const ptr = api.alloc_scratch(byteLen)
  // Re-create view over memory.buffer after alloc_scratch in case WASM memory grew.
  new Uint8Array(api.memory.buffer, ptr, byteLen).set(pixels)
  runScratchFilter(api, byteLen, filter)
  pixels.set(new Uint8Array(api.memory.buffer, ptr, byteLen))
}

export async function applyPixelFilterInPlace(
  pixels: Uint8ClampedArray | Uint8Array,
  filter: PixelFilterName
): Promise<void> {
  const cached = getCachedWasmApi()
  if (cached) {
    applyPixelFilterInPlaceSync(cached, pixels, filter)
    return
  }

  const api = await loadWasmApi()
  applyPixelFilterInPlaceSync(api, pixels, filter)
}

export async function applyPixelFilter(pixels: Uint8Array, filter: PixelFilterName): Promise<Uint8Array> {
  await applyPixelFilterInPlace(pixels, filter)
  return pixels
}
