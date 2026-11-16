# avi architecture

avi is a local-first non-linear editor. The desktop app is the primary product. The browser build is the same React UI without native file access.

## Layout

```
avi/
├── app/          React + Vite editor
├── api/          Optional Express API (Gemini proxy + protected projects)
├── wasm/         Rust pixel filters, compiled to WASM
└── src-tauri/    Tauri 2 desktop shell
```

Package names are `avi`, `@avi/app`, and `@avi/api`. The Rust desktop crate is `avi` and the WASM crate is `avi-wasm`.

## Desktop shell

Tauri 2 wraps the Vite app. The shell crate requires `tauri` 2.9, and `Cargo.lock` resolves that to 2.12.3. `@tauri-apps/cli` 2.12 drives it. The locked plugins are `tauri-build` 2.7.2, `tauri-plugin-dialog` 2.8.2, and `tauri-plugin-fs` 2.7.0. `src-tauri/tauri.conf.json` points `devUrl` at `http://127.0.0.1:1420` and `frontendDist` at `../app/dist`. `beforeDevCommand` and `beforeBuildCommand` set `cwd` to the repo root, so `npm run tauri:dev` and `npm run tauri:build` work from that root on macOS, Windows, and Linux. The browser preview stays on port 3000 and is not the product.

The window title is `avi`. The bundle identifier is `me.csy20.avi`.

Native open and save dialogs come from `tauri-plugin-dialog`. Selected media is not copied into IndexedDB. `allow_media_path` validates media extensions and registers the real file for the session. Playback does not use `convertFileSrc`: WebKitGTK reports media error 4 for `asset://` video URLs. The shell instead serves only those allowed files from `127.0.0.1` with HTTP range requests, a per-launch random session token, restricted CORS origins, and a bounded worker pool. Export paths are approved in Rust via `pick_export_path` without granting `fs:scope-home-recursive`.

`security.csp` defines an explicit policy allowing `'self'`, `'wasm-unsafe-eval'`, local loopback media/API origins, `blob:` / `asset:` URLs, and optional Supabase HTTPS/WSS endpoints while disallowing objects and framing.

Playback proxies are optional. When `ffmpeg` is on `PATH`, `generate_proxy` uses a bounded worker semaphore to atomically write `proxies/{assetId}.mp4` via `.tmp.mp4` (`scale=-2:'min(720,ih)'`, libx264 veryfast, CRF 28, `-movflags +faststart`). The preview prefers that file. Export always uses the original and `delete_proxy` cleans up orphaned proxies when assets are removed.

## Timeline

Tracks and clips stay the existing model: integer frames at the project `fps`, inclusive `startFrame` / `endFrame`, and source `mediaStart` / `mediaEnd`. Visual compositing sorts tracks explicitly by layer (`audio` -> `video` -> `overlay`). Undo stores the last 50 full trees.

Move is a live update and becomes one history step on mouseup. Dragging snaps to frame 0, the playhead, and other clip edges. Arrow keys nudge by 1 frame, or 5 with Shift, and do not snap. `Space` toggles play/pause. `Shift+Delete` ripple-deletes.

## Preview and color

Remotion Player is the compositor. While the playhead is moving, a clip `pixelFilter` is a CSS filter. While it is paused, the same frame is drawn with cover-crop scaling through the WASM in-place linear-memory scratch filters (`grayscale`, `sepia`, `invert`, `brightness`, `color_matrix` for warm) and cached per frame.

On desktop with `ffmpeg` installed, `export_timeline` renders MP4/WebM deterministically via an FFmpeg filtergraph. In browser mode or when `ffmpeg` is absent, `videoExportService.ts` steps frames deterministically into a Canvas + MediaRecorder WebM stream at 720p or 1080p.

## Projects and AI

With no Supabase env vars the editor opens immediately. The working timeline is stored at `avi.localProject.v1` in `localStorage`. Media bytes for browser uploads stay in IndexedDB (`avi-local-assets`, `avi-media-storage`, `avi-waveform-cache`). Signing in promotes a non-empty local timeline to a new cloud project, migrates local IndexedDB asset ownership to the new project UUID, and syncs asset metadata to `public.assets`.

`POST /api/prompt` prefers Gemini (`GEMINI_MODEL`, default `gemini-2.5-flash`) with `x-goog-api-key` and a 30s timeout. A missing key or invalid response falls back to word-boundary local heuristics. `requireAuth` supports `HS256` (`SUPABASE_JWT_SECRET`) and `ES256`/`RS256` JWKS, protecting both `/api/prompt` and `/api/projects`.
