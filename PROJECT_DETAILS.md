# avi: AI-Powered Video Editor

## Project Overview

**avi** is a local-first AI video editor that combines a timeline-based editing interface with AI-assisted composition edits. It runs as a Tauri 2 desktop application (macOS, Windows, Linux) or browser preview, allowing users to import media assets (video, audio, images), arrange them on a multi-track timeline, and use AI prompts or local heuristics to modify compositions.

### Core Features

1. **Timeline-Based Editing** - Multi-track timeline for video, audio, and overlay tracks with zoom, vertical scrolling, mute, add/remove tracks, snapping, split, duplicate, trim, and ripple delete
2. **AI Prompt Integration** - Natural language timeline edits via Gemini (`gemini-2.5-flash` default) when configured, with automatic word-boundary local fallback
3. **WebAssembly Processing** - Client-side pixel filters and luma statistics compiled from Rust (`avi-wasm`), using an in-place linear WASM scratch buffer
4. **Optional Cloud Sync** - Supabase Auth (email/password + GitHub OAuth with desktop loopback callback), multi-project switching (`public.projects`), and cloud asset metadata (`public.assets`)
5. **Video Export** - Native desktop FFmpeg MP4/WebM export (when `ffmpeg` is available) and deterministic frame-stepped browser WebM export (720p and 1080p presets)
6. **Asset Library** - Browser uploads stored in IndexedDB (`avi-local-assets` + `avi-media-storage` + `avi-waveform-cache`), or native file references served through an authenticated loopback `MediaServer` in the desktop app

---

## Architecture

### Monorepo Structure

```
avi/
├── app/                    # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/    # React components (AssetLibrary, PlayerPanel, Timeline, Modals, WasmPanel)
│   │   ├── hooks/         # Custom React hooks (shortcuts, project manager, WASM, modal focus trap)
│   │   ├── lib/           # Services (assets, projects, export, WASM pixel filters, waveforms)
│   │   ├── store/         # Zustand state management
│   │   ├── wasm-pkg/      # Generated WebAssembly module (gitignored; built by wasm-pack)
│   │   └── remotion/      # Remotion preview composition
│   └── package.json
│
├── api/                   # Backend (Express + Node.js)
│   ├── src/
│   │   ├── routes/        # /api/prompt and /api/projects endpoints
│   │   └── middleware/    # JWT verification (HS256 + ES256/RS256 JWKS)
│   └── package.json
│
├── wasm/                  # Rust pixel-filter WASM crate (`avi-wasm`)
├── src-tauri/             # Tauri 2 desktop shell (`avi`)
└── package.json           # Root workspace configuration (Node >= 22.6.0)
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend Framework | React 18 |
| Build Tool | Vite 6 |
| State Management | Zustand 5 |
| Preview | Remotion Player 4 |
| Export | Native FFmpeg (`export_timeline`) on desktop, deterministic Canvas + MediaRecorder WebM fallback |
| Desktop | Tauri 2 |
| WebAssembly | Rust (`wasm-pack`) |
| Backend | Express.js 4 (optional) |
| Database/Auth | Supabase (optional) |
| AI Integration | Gemini (`gemini-2.5-flash`) when configured, local heuristics otherwise |
| Validation | Zod 4 |

---

## Frontend Architecture (app/)

### Component Hierarchy

```
App.tsx
├── Header (toolbar)
│   ├── Logo & branding
│   ├── Asset Library toggle
│   ├── Save button
│   ├── Export preset selector & Export button
│   ├── Undo / Redo buttons
│   ├── WASM benchmark panel toggle
│   ├── Project switcher button
│   ├── Offline indicator
│   └── Keyboard shortcuts & Sign In / Sign Out
│
├── WasmPanel (optional, toggle-gated WASM benchmark widget)
│
├── Main Content Area
│   ├── AssetLibrary (sidebar)
│   └── PlayerPanel (video preview + GhostPreviewBar + keyboard-accessible scrubber)
│
├── Timeline (zoom, vertical scroll, track add/mute/delete, ruler, clips, playhead)
├── ProjectSwitcherModal (multi-project switcher, create/rename/delete)
├── PromptModal (AI prompt interface with VITE_API_BASE_URL support)
├── AuthModal (login/signup + GitHub OAuth)
├── UploadFirstCanvas (initial state)
└── ToastContainer (accessible polite live region)
```

### State Management

The editor uses **Zustand** (`useEditorStore.ts`) with fine-grained selectors to isolate high-frequency `playheadPosition` updates to leaf components (`Playhead`, `PlayerScrubber`, `ActiveClipLabelsOverlay`, `PausedWasmGrade`):

- `compositionTree: Track[]` - Current timeline composition
- `proposedComposition: Track[] | null` / `proposedMeta` - AI-generated preview (auto-opens split-screen comparison)
- `playheadPosition: number` - Current frame position (`Number.isFinite` guarded)
- `selectedClip: SelectedClip | null` - Currently selected clip
- `totalFrames: number` - Total timeline duration
- `fps: number` - Frames per second (default: 30)
- `history: Track[][]` - Undo history stack (up to 50 snapshots)

### Persistence

- **Local project state**: Stored in `localStorage` under `avi.localProject.v1` when signed out.
- **Local media bytes & metadata**: Stored in IndexedDB (`avi-local-assets` for asset metadata, `avi-media-storage` for browser file blobs, `avi-waveform-cache` for decoded audio peaks).
- **Cloud sync**: When signed in with Supabase configured, `useProjectManager` saves projects to `public.projects` (with debounced auto-save retained across failures + `flush()`/`cancel()`), migrates `'local'` IndexedDB assets on sign-in, and syncs asset records to `public.assets`.

---

## Backend Architecture (api/)

### API Endpoints

**Default Base URL:** `http://localhost:4000` (configurable via `VITE_API_BASE_URL` for packaged desktop builds)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/prompt` | POST | Yes | AI prompt processing (rate-limited: 10 req/min) |
| `/api/projects` | GET / POST | Yes | List or create user projects via Supabase RLS |
| `/api/projects/:id` | GET / PATCH / DELETE | Yes | Read, update, or delete a user project via Supabase RLS |

### Authentication Middleware

`requireAuth.ts` verifies Supabase Bearer JWTs using:
- `HS256` via `SUPABASE_JWT_SECRET` (when configured), and/or
- `ES256` / `RS256` via `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.

### AI Processing Pipeline (`/api/prompt`)

1. **Validation** - Zod enforces `totalFrames >= 1`, `frameRange.endFrame >= frameRange.startFrame`, and `clip.trackId === track.id`.
2. **Gemini API Call** - Calls `GEMINI_MODEL` (default `gemini-2.5-flash`) with `x-goog-api-key` header and a 30s timeout.
3. **Media Integrity** - `restoreOriginalClipMedia` preserves original `assetUrl`, `assetId`, and `mediaDurationFrames` on returned clips.
4. **Fallback Mode** - If Gemini is unavailable or validation fails, `mockLLM` applies word-boundary keyword mutations with media-duration clamping.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + K` | Open AI prompt modal |
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Y` / `Cmd/Ctrl + Shift + Z` | Redo |
| `Enter` | Accept AI proposal (outside inputs/buttons) |
| `Esc` | Reject AI proposal / Close active modal |
| `S` | Split selected clip at playhead |
| `D` | Duplicate selected clip |
| `Delete` / `Backspace` | Delete selected clip (`Shift+Delete` to ripple delete) |
| `←` / `→` | Nudge selected clip by 1 frame (`Shift` for 5 frames) |
| `Space` | Play / Pause |

---

## Environment Variables

See `.env.example`, `app/.env.example`, and `api/.env.example` for current defaults and optional configuration variables.
