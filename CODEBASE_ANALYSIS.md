# avi codebase — robustness and logic analysis

**Project:** avi (AI video editor)
**Scope:** Full-stack audit across `app/src/`, `api/src/`, `wasm/src/`, and `src-tauri/src/`

---

## Summary of Implemented Safeguards

1. **Remotion 4 trim coordinates (`clipValidation.ts`, `TrackPreviewComposition.tsx`)**:
   - `getSafeMediaTrimProps` emits `trimAfter = Math.floor(mediaEnd) + 1` (exclusive source frame coordinate, strictly `> trimBefore`) when tail-trimmed, instead of the count of removed tail frames.
   - `normalizeTimeline` preserves intentional intro gaps rather than shifting clips left to frame `0`.

2. **Database & API auth (`supabase_schema.sql`, `projectService.ts`, `requireAuth.ts`, `api/src/index.ts`, `api/src/routes/projects.ts`)**:
   - `public.projects.user_id` and `public.assets.user_id` specify `DEFAULT auth.uid()`, and `createProject()` sends `user_id` explicitly from the active session.
   - `UPDATE` RLS policies include `WITH CHECK`, `handle_new_user()` sets `SET search_path = ''`, and Storage example policies scope reads/writes to `(storage.foldername(name))[1] = auth.uid()::text`.
   - `requireAuth` supports `HS256` (`SUPABASE_JWT_SECRET`) as well as `ES256`/`RS256` JWKS, and `/api/projects` is protected by `requireAuth` and implemented via user-scoped Supabase RLS.

3. **Auto-save & offline reconnect reliability (`projectService.ts`, `useProjectManager.ts`)**:
   - `createAutoSave()` retains `pendingSave` until async completion (without clobbering newer queued saves), returns save outcome from `flush()`, and exposes `cancel()` for unmount/sign-out/project switch cleanup.
   - `forceSave()` and `avi:reconnect` flush pending work and persist `useEditorStore.getState()` directly whenever `hasUnsavedChanges` remains true, throwing on failure so UI notifications stay accurate.
   - `currentProjectId` in `localStorage` is cleared only when `getProject()` confirms the project does not exist (`null`), never on transient network errors.

4. **Desktop security & media serving (`src-tauri/src/media_server.rs`, `src-tauri/src/lib.rs`, `tauri.conf.json`, `capabilities/default.json`)**:
   - `MediaServer` uses a bounded worker thread pool, `BufReader`, socket timeouts, case-insensitive `Range` parsing, valueless query tolerance, RFC 9110 bodyless `204 No Content`, restricted Tauri/dev CORS origins, and a random per-launch session token.
   - Tauri commands validate media extensions, cache `media_tools` with `OnceLock`, bound concurrent FFmpeg proxy encodes, write proxies atomically via `.tmp.mp4` -> rename (`scale=-2:'min(720,ih)'`, `-movflags +faststart`), delete proxies on asset removal (`delete_proxy`), and enforce dialog-approved export paths (`pick_export_path` + `write_export_bytes` / `export_timeline`) without `fs:scope-home-recursive` or `csp: null`.

5. **Export, preview, WASM & UI performance (`videoExportService.ts`, `wasm/src/lib.rs`, `pixelFilter.ts`, `PlayerPanel.tsx`, `Timeline.tsx`)**:
   - `videoExportService.ts` creates/closes `AudioContext` inside `try/finally`, awaits `seeked` before drawing, steps frames deterministically without background-throttled `requestAnimationFrame`, drops the 1000ms minimum duration pad, guards `0` dimensions, sorts tracks by visual layer (`video` below `overlay`), and scales text proportionally (`height / 720`).
   - `avi-wasm` exposes a reusable linear-memory scratch buffer (`alloc_scratch` + `*_in_place`) and `Result`-returning `frame_luma_stats`, eliminating per-frame JS<->WASM RGBA heap copies.
   - `PausedWasmGrade` separates media element creation from frame scrubbing, uses cover-crop scaling, cleans up named listeners, and caches graded `ImageData`.
   - `Timeline`, `PlayerPanel`, `TimelineRuler`, and `TrackPreviewComposition` scope Zustand selectors and `useCurrentFrame()` to leaf components so 30fps playback does not re-render the full editor tree.
