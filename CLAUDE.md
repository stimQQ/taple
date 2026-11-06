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

## Audio: Known Decisions

- Mono microphone samples are mixed at `gain × 1.0` into both channels (`crates/audio/src/renderer.rs`); the old `0.707` factor made recordings too quiet.
- `mic_volume_db` defaults to `20.0` dB (`crates/project/src/configuration.rs`).
- Editor mic and system audio sliders range from -30 dB to +20 dB (`apps/desktop/src/routes/editor/ConfigSidebar.tsx`).

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
