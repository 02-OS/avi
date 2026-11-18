#![allow(clippy::manual_is_multiple_of, clippy::chunks_exact_to_as_chunks)]

use std::cell::RefCell;
use wasm_bindgen::{prelude::*, JsValue};

const RGBA_LEN_ERR: &str = "pixel buffer length must be a multiple of 4 (RGBA)";
const LUMA_EMPTY_ERR: &str = "pixel buffer must be non-empty and a multiple of 4 (RGBA)";
const MATRIX_LEN_ERR: &str = "color matrix must contain 20 floats";
const SCRATCH_LEN_ERR: &str = "requested byte length exceeds allocated scratch buffer";

thread_local! {
    static SCRATCH_BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

// ── Panic hook ────────────────────────────────────────────────────────────────
// Redirects Rust panics to browser console.error so debugging is bearable.
#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

// ── Shared pure-Rust pixel kernels ────────────────────────────────────────────

fn apply_grayscale_slice(pixels: &mut [u8]) -> Result<(), &'static str> {
    if pixels.len() % 4 != 0 {
        return Err(RGBA_LEN_ERR);
    }

    for chunk in pixels.chunks_exact_mut(4) {
        let luma = (0.299 * chunk[0] as f32
            + 0.587 * chunk[1] as f32
            + 0.114 * chunk[2] as f32)
            .round() as u8;
        chunk[0] = luma;
        chunk[1] = luma;
        chunk[2] = luma;
        // chunk[3] = alpha — untouched
    }
    Ok(())
}

fn apply_invert_slice(pixels: &mut [u8]) -> Result<(), &'static str> {
    if pixels.len() % 4 != 0 {
        return Err(RGBA_LEN_ERR);
    }

    for chunk in pixels.chunks_exact_mut(4) {
        chunk[0] = 255 - chunk[0];
        chunk[1] = 255 - chunk[1];
        chunk[2] = 255 - chunk[2];
    }
    Ok(())
}

fn apply_brightness_slice(pixels: &mut [u8], factor: f32) -> Result<(), &'static str> {
    if pixels.len() % 4 != 0 {
        return Err(RGBA_LEN_ERR);
    }

    for chunk in pixels.chunks_exact_mut(4) {
        chunk[0] = ((chunk[0] as f32 * factor).round() as i32).clamp(0, 255) as u8;
        chunk[1] = ((chunk[1] as f32 * factor).round() as i32).clamp(0, 255) as u8;
        chunk[2] = ((chunk[2] as f32 * factor).round() as i32).clamp(0, 255) as u8;
    }
    Ok(())
}

fn compute_luma_stats(pixels: &[u8]) -> Result<Vec<f32>, &'static str> {
    if pixels.is_empty() || pixels.len() % 4 != 0 {
        return Err(LUMA_EMPTY_ERR);
    }
    let mut min: f32 = 255.0;
    let mut max: f32 = 0.0;
    let mut sum: f64 = 0.0;
    let mut count: u32 = 0;

    for chunk in pixels.chunks_exact(4) {
        let luma = 0.299 * chunk[0] as f32
            + 0.587 * chunk[1] as f32
            + 0.114 * chunk[2] as f32;
        if luma < min {
            min = luma;
        }
        if luma > max {
            max = luma;
        }
        sum += luma as f64;
        count += 1;
    }

    let mean = (sum / count as f64) as f32;
    Ok(vec![min, max, mean, count as f32])
}

fn apply_sepia_slice(pixels: &mut [u8]) -> Result<(), &'static str> {
    if pixels.len() % 4 != 0 {
        return Err(RGBA_LEN_ERR);
    }

    for chunk in pixels.chunks_exact_mut(4) {
        let r = chunk[0] as f32;
        let g = chunk[1] as f32;
        let b = chunk[2] as f32;
        chunk[0] = ((0.393 * r + 0.769 * g + 0.189 * b).round() as i32).clamp(0, 255) as u8;
        chunk[1] = ((0.349 * r + 0.686 * g + 0.168 * b).round() as i32).clamp(0, 255) as u8;
        chunk[2] = ((0.272 * r + 0.534 * g + 0.131 * b).round() as i32).clamp(0, 255) as u8;
    }
    Ok(())
}

fn apply_color_matrix_slice(pixels: &mut [u8], matrix: &[f32]) -> Result<(), &'static str> {
    if pixels.len() % 4 != 0 {
        return Err(RGBA_LEN_ERR);
    }
    if matrix.len() != 20 {
        return Err(MATRIX_LEN_ERR);
    }

    for chunk in pixels.chunks_exact_mut(4) {
        let r = chunk[0] as f32 / 255.0;
        let g = chunk[1] as f32 / 255.0;
        let b = chunk[2] as f32 / 255.0;
        let a = chunk[3] as f32 / 255.0;

        let next = |row: usize| {
            let index = row * 5;
            matrix[index] * r
                + matrix[index + 1] * g
                + matrix[index + 2] * b
                + matrix[index + 3] * a
                + matrix[index + 4]
        };

        chunk[0] = (next(0) * 255.0).round().clamp(0.0, 255.0) as u8;
        chunk[1] = (next(1) * 255.0).round().clamp(0.0, 255.0) as u8;
        chunk[2] = (next(2) * 255.0).round().clamp(0.0, 255.0) as u8;
        chunk[3] = (next(3) * 255.0).round().clamp(0.0, 255.0) as u8;
    }

    Ok(())
}

fn with_scratch_mut<T>(
    byte_len: usize,
    op: impl FnOnce(&mut [u8]) -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    SCRATCH_BUFFER.with(|cell| {
        let mut buf = cell.borrow_mut();
        if byte_len > buf.len() {
            return Err(SCRATCH_LEN_ERR);
        }
        op(&mut buf[..byte_len])
    })
}

fn with_scratch_ref<T>(
    byte_len: usize,
    op: impl FnOnce(&[u8]) -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    SCRATCH_BUFFER.with(|cell| {
        let buf = cell.borrow();
        if byte_len > buf.len() {
            return Err(SCRATCH_LEN_ERR);
        }
        op(&buf[..byte_len])
    })
}

// ── Reusable linear-memory scratch buffer API (zero-copy JS<->WASM grading) ─

/// Ensure the internal RGBA scratch buffer has at least `byte_len` bytes and return its WASM linear memory pointer.
/// Callers must re-read `wasm.memory.buffer` after invoking this, as growing WASM memory detaches prior ArrayBuffers.
#[wasm_bindgen]
pub fn alloc_scratch(byte_len: usize) -> *mut u8 {
    SCRATCH_BUFFER.with(|cell| {
        let mut buf = cell.borrow_mut();
        if buf.len() != byte_len {
            buf.resize(byte_len, 0);
        }
        buf.as_mut_ptr()
    })
}

#[wasm_bindgen]
pub fn grayscale_in_place(byte_len: usize) -> Result<(), JsValue> {
    with_scratch_mut(byte_len, apply_grayscale_slice).map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub fn invert_in_place(byte_len: usize) -> Result<(), JsValue> {
    with_scratch_mut(byte_len, apply_invert_slice).map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub fn brightness_in_place(byte_len: usize, factor: f32) -> Result<(), JsValue> {
    with_scratch_mut(byte_len, |pixels| apply_brightness_slice(pixels, factor))
        .map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub fn sepia_in_place(byte_len: usize) -> Result<(), JsValue> {
    with_scratch_mut(byte_len, apply_sepia_slice).map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub fn color_matrix_in_place(byte_len: usize, matrix: &[f32]) -> Result<(), JsValue> {
    with_scratch_mut(byte_len, |pixels| apply_color_matrix_slice(pixels, matrix))
        .map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub fn frame_luma_stats_in_place(byte_len: usize) -> Result<Vec<f32>, JsValue> {
    with_scratch_ref(byte_len, compute_luma_stats).map_err(JsValue::from_str)
}

// ── Owned-Vec WASM exports (backwards-compatible) ─────────────────────────────

/// Convert an RGBA pixel buffer to greyscale.
/// Uses ITU-R BT.601 luma coefficients: Y = 0.299R + 0.587G + 0.114B.
/// Alpha channel is preserved unchanged.
#[wasm_bindgen]
pub fn grayscale(mut pixels: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    apply_grayscale_slice(&mut pixels).map_err(JsValue::from_str)?;
    Ok(pixels)
}

/// Invert every colour channel (255 - value). Alpha is preserved.
#[wasm_bindgen]
pub fn invert(mut pixels: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    apply_invert_slice(&mut pixels).map_err(JsValue::from_str)?;
    Ok(pixels)
}

/// Multiply each colour channel by `factor` and clamp to [0, 255].
/// factor > 1.0 brightens, 0.0 < factor < 1.0 darkens. Alpha preserved.
#[wasm_bindgen]
pub fn brightness(mut pixels: Vec<u8>, factor: f32) -> Result<Vec<u8>, JsValue> {
    apply_brightness_slice(&mut pixels, factor).map_err(JsValue::from_str)?;
    Ok(pixels)
}

/// Compute per-frame luma statistics.
/// Returns a Float32Array of 4 values: [min, max, mean, pixel_count].
#[wasm_bindgen]
pub fn frame_luma_stats(pixels: &[u8]) -> Result<Vec<f32>, JsValue> {
    compute_luma_stats(pixels).map_err(JsValue::from_str)
}

/// Classic sepia tone filter. Alpha preserved.
#[wasm_bindgen]
pub fn sepia(mut pixels: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    apply_sepia_slice(&mut pixels).map_err(JsValue::from_str)?;
    Ok(pixels)
}

/// Apply a row-major 4×5 color matrix to RGBA pixels.
/// Channels are converted to 0–1, multiplied, then scaled back to bytes.
/// `matrix` must contain 20 floats: four rows of `[r, g, b, a, offset]`.
#[wasm_bindgen]
pub fn color_matrix(mut pixels: Vec<u8>, matrix: &[f32]) -> Result<Vec<u8>, JsValue> {
    apply_color_matrix_slice(&mut pixels, matrix).map_err(JsValue::from_str)?;
    Ok(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luma_stats_rejects_empty_and_unaligned_buffers() {
        assert!(compute_luma_stats(&[]).is_err());
        assert!(compute_luma_stats(&[10, 20, 30]).is_err());
    }

    #[test]
    fn luma_stats_computes_expected_values() {
        let pixels = [0, 0, 0, 255, 255, 255, 255, 128];
        let stats = compute_luma_stats(&pixels).unwrap();
        assert!((stats[0] - 0.0).abs() < 1e-4);
        assert!((stats[1] - 255.0).abs() < 1e-4);
        assert!((stats[2] - 127.5).abs() < 1e-2);
        assert_eq!(stats[3], 2.0);
    }

    #[test]
    fn scratch_buffer_grades_in_place_without_changing_alpha() {
        let ptr = alloc_scratch(8);
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::copy_nonoverlapping(
                [100u8, 150, 200, 123, 10, 20, 30, 250].as_ptr(),
                ptr,
                8,
            );
        }

        with_scratch_mut(8, apply_invert_slice).unwrap();
        let stats = with_scratch_ref(8, compute_luma_stats).unwrap();
        assert_eq!(stats[3], 2.0);

        SCRATCH_BUFFER.with(|cell| {
            let buf = cell.borrow();
            assert_eq!(&buf[0..4], &[155, 105, 55, 123]);
            assert_eq!(&buf[4..8], &[245, 235, 225, 250]);
        });

        // Requesting more than allocated scratch size fails cleanly.
        assert!(with_scratch_mut(16, apply_grayscale_slice).is_err());
    }

    #[test]
    fn color_matrix_validates_lengths() {
        assert!(apply_color_matrix_slice(&mut [1, 2, 3], &[0.0; 20]).is_err());
        assert!(apply_color_matrix_slice(&mut [1, 2, 3, 255], &[0.0; 19]).is_err());
    }
}
