# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

Taple is a free, open source screen recorder for product demos and tutorials on macOS. It is a fork of [Cap](https://github.com/CapSoftware/Cap), released under AGPLv3.

- Free, local-only app: no accounts, no paid plans, no cloud sharing, no analytics in official builds.
- Target users are outside China; the desktop UI follows the system language (Chinese or English).
- The website is a static site in `apps/website`, deployed to Cloudflare Pages at https://taple.app.
- Keep the AGPL attribution to Cap in `README.md` and `LICENSE`. Internal package and crate names (`@cap/ui-solid`, `cap-*` crates) are intentionally unchanged so upstream changes stay mergeable; do not show the Cap name to users.

## Repository Layout

- `apps/desktop/`: the macOS app (Tauri v2, Rust 2024, SolidStart/SolidJS)
  - `src/`: SolidJS frontend (routes, editor, settings)
  - `src-tauri/`: Rust backend, windows, tray, recording and export commands
- `apps/website/`: static marketing site (plain HTML/CSS, no build step)
- `apps/cli/`: developer CLI (`taple-cli`)
- `packages/ui-solid/`: SolidJS components, icons, Tailwind and PostCSS config for the desktop app
- `crates/*`: Rust crates for capture, encoding, rendering, audio, camera and project files
- `patches/libDF/`: modified DeepFilterNet noise reduction library (kept in upstream formatting, excluded from `cargo fmt` and Clippy)

## Key Commands

```bash
pnpm install
pnpm env-setup           # writes a development .env
pnpm cap-setup           # downloads FFmpeg and other native dependencies
pnpm dev:desktop         # runs the desktop app (SolidStart + Tauri dev)
pnpm tauri:build         # release build of the desktop app
pnpm typecheck           # TypeScript project references build
pnpm format              # Biome format
pnpm lint                # Biome lint
cargo fmt --all
cargo clippy --workspace --all-features --locked --exclude deep_filter
```

Do not start dev servers or launch the app unless asked.

## Conventions

- No code comments: never add inline, block or doc comments in any language.
- Desktop UI language follows the macOS system language (Chinese when it starts with `zh`, English otherwise). Wrap every user-facing desktop string as `L("中文", "English")` from `~/utils/i18n`; in Rust use `crate::i18n::tr("中文", "English")`. macOS permission prompts live in `src-tauri/Info.plist` (English) and `src-tauri/zh-Hans.lproj/InfoPlist.strings`.
- The website is English only.
- Strict TypeScript, avoid `any`. Biome for formatting and linting; CI runs `biome ci . --linter-enabled=false`, which also checks import order.
- Rust: the workspace denies several Clippy lints (`collapsible_if`, `unchecked_duration_subtraction`, `dbg_macro` and others in `Cargo.toml`). CI uses the latest stable toolchain, which can flag code that an older local toolchain accepts.
- Use pnpm only. Commit `pnpm-lock.yaml` with dependency changes.

## Desktop Patterns

- `apps/desktop/src/utils/tauri.ts` is generated from Rust types by tauri-specta when the debug app starts. Never edit it by hand. `queries.ts` is hand-written.
- IPC uses tauri-specta `commands` and `events`. Data fetching on the frontend uses `@tanstack/solid-query`.
- Windowing and permissions are handled in Rust; keep UI logic in Solid.
- Icons are auto-imported through `unplugin-icons` (`IconCap*` from `packages/ui-solid/icons`, `IconLucide*`); do not import them manually.
- Recordings are `.taple` project directories. The app still opens older `.sparkvideo` and `.cap` projects.
- The setup window only appears when screen recording or accessibility permission is missing.

## AI Agents (MCP)

- Taple serves MCP on a Unix socket in the app data directory (`mcp.sock`, mode 0600) from `apps/desktop/src-tauri/src/mcp.rs`. Clients launch the app binary with `--mcp --socket <path>` (`mcp_bridge.rs`), which pipes stdio to the socket and starts Taple when it is not running.
- `list_recordings` and `open_recording` run in Rust; every other tool runs in the open editor (`apps/desktop/src/routes/editor/mcpHost.ts`) with the same tool code as the built-in AI Edit, so the editing rules, live timeline and undo behave the same. `view_frames` returns the contact sheet image when there is no vision helper.
- Rust lists tools from `apps/desktop/src-tauri/mcp-catalog.json`, generated from the TypeScript tool definitions. After changing a tool, run `UPDATE_MCP_CATALOG=1 pnpm --filter @taple/desktop exec vitest run src/utils/ai/mcp.ts`; the test fails while the file is stale.
- Settings → AI connects Claude Code (via the `claude` CLI, else `~/.claude.json`), Codex (`~/.codex/config.toml`), Claude Desktop and Cursor in one click (`mcp_install.rs`); each edited file is backed up as `*.taple-backup`.

## Feedback & Changelog

- Settings → Send Feedback posts to `https://taple.app/api/feedback` (`apps/desktop/src-tauri/src/feedback.rs`). The Pages Function `apps/website/functions/api/feedback.js` validates it, applies a 30-second per-IP cooldown and sends a plain-text email through Resend (`reply_to` is the user's address; optional log tail attached as `taple.log` with the home folder replaced by `~`).
- Settings → Changelog shows GitHub Release notes (`changelog.rs`): it reads `https://taple.app/api/releases` (`apps/website/functions/api/releases.js`, cached 10 minutes; the GitHub API often answers 403 to Cloudflare's shared IPs, so the function falls back to the `releases.atom` feed) and falls back to the GitHub API, whose anonymous limit is 60 requests per hour per IP. Release notes are written in the GitHub Release body. The app strips remote HTML down to basic tags (`apps/desktop/src/utils/releaseNotes.ts`).
- Pages environment: `RESEND_API_KEY` (secret), `FEEDBACK_TO` (comma-separated recipients), optional `FEEDBACK_FROM` (default `Taple Feedback <feedback@taple.app>`, the domain must be verified in Resend) and optional `GITHUB_TOKEN`.
- Cloudflare Pages project `taple`, served at https://taple.app and https://www.taple.app (also https://taple-yw4.pages.dev). Environment changes only apply to new deployments, so deploy again after setting a secret.
- Run `wrangler pages dev .` from `apps/website`: Wrangler only picks up the `functions` folder in the current directory. To deploy, copy `apps/website` without `.wrangler` and `node_modules` (local dev state that would otherwise be uploaded) and run `wrangler pages deploy . --project-name taple --branch main` inside the copy. Set `TAPLE_SITE_URL` (for example `http://localhost:8788` or the pages.dev address) when running the desktop app to use another site.

## Audio: Known Decisions

- Mono microphone samples are mixed at `gain × 1.0` into both channels (`crates/audio/src/renderer.rs`); the old `0.707` factor made recordings too quiet.
- `mic_volume_db` defaults to `20.0` dB (`crates/project/src/configuration.rs`).
- Editor mic volume slider ranges from -30 dB to +30 dB and system audio from -30 dB to +20 dB (`apps/desktop/src/routes/editor/ConfigSidebar.tsx`); raw mic files are quiet, so +20 dB or more is normal.
- The final mix goes through a stateless soft limiter (threshold -1 dBFS, ceiling 0.995) in `crates/editor/src/audio.rs`, shared by preview playback and export.
- Audio cleanup (`apps/desktop/src/routes/editor/audioEnhancement.ts`): noise reduction first, then loudness. Loudness is measured per ITU-R BS.1770 on the (denoised) mic and the mic volume is set to reach -16 LUFS, capped so robust peaks stay under +3 dBFS before the limiter. New recordings get `audio.enhancePending` when the "Clean Up Audio After Recording" setting is on, and the editor runs the cleanup on open; AI Edit runs the same cleanup before transcription. `audio.autoLevelDb` marks an applied auto level and `audio.keepOriginalAudio` records that the user restored the original, so neither is redone automatically.
- Noise reduction runs on ONNX Runtime (`patches/libDF/src/ort_impl.rs`) on Apple silicon and on tract (`patches/libDF/src/offline.rs`) on Intel, because ONNX Runtime no longer ships prebuilt Intel Mac binaries. The desktop crate picks the `df` features per `target_arch`. Both produce the same output; keep tract at 0.22 or later (0.21.10 computes wrong DeepFilterNet results, and 0.21.11 and later pin `half = 2.4.1`, which conflicts with wgpu). The tract models must be optimized (`m.optimize()` in `tract.rs`), otherwise inference is about 100 times slower.
- Noise reduction (`apps/desktop/src-tauri/src/noise_reduction.rs`, `patches/libDF/src/ort_impl.rs`) keeps the untouched mic as `*.original.ogg`, always processes from that original, normalizes the speech level to about -24 dBFS before DeepFilterNet (the model treats very quiet speech as noise) and aligns the model output with its 2-frame lookahead. The editor swaps the new audio in place (`EditorInstance::reload_microphone_audio`) without reloading the window.

## Troubleshooting

- `target_display_crop: Display not found`: the CGDisplayID changed after sleep or a display reconnect; `crates/recording/src/capture_pipeline.rs` falls back to `Display::primary()`.
- Recording failures: check screen recording permission. In dev, permissions apply to the terminal that runs the app.
- After moving the repository folder, clear Rust build-script outputs that still point to the old path (`cargo clean -p <crate>` for the affected crates).

## Release & Distribution

Releases are built, signed, notarized and published by `.github/workflows/publish.yml` (GitHub Actions → `publish` → Run workflow). It uploads the DMGs, updater bundles and `latest.json` to GitHub Releases.

Required GitHub secrets:

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Developer ID Application .p12, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: …` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_KEY_FILE` | .p8 file contents |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater signing private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Only if the updater key has a password |

- Downloads: `https://github.com/stimQQ/taple/releases/latest/download/Taple_{aarch64,x86_64}.dmg`
- Auto-update endpoint: `https://github.com/stimQQ/taple/releases/latest/download/latest.json` (configured in `tauri.prod.conf.json`)
