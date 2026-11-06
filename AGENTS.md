# Repository Guidelines

See `CLAUDE.md` for the full guide. The essentials:

## Project Structure
- `apps/desktop`: the macOS app (Tauri v2 + SolidStart). `apps/website`: static site for taple.app. `apps/cli`: developer CLI.
- `packages/ui-solid`: SolidJS components, icons, Tailwind and PostCSS config.
- `crates/*`: Rust capture, encoding, rendering, audio and camera crates. `patches/libDF`: modified DeepFilterNet.

## Build, Test, Develop
- Install: `pnpm install`; setup: `pnpm env-setup` then `pnpm cap-setup`.
- Desktop dev: `pnpm dev:desktop`. Release build: `pnpm tauri:build`.
- Quality: `pnpm typecheck`, `pnpm format`, `pnpm lint`, `cargo fmt --all`, `cargo clippy --workspace --all-features --locked --exclude deep_filter`.

## Coding Style
- No code comments. Biome formats and lints TypeScript; rustfmt and workspace Clippy lints for Rust.
- Every user-facing desktop string is `L("中文", "English")` from `~/utils/i18n` (Rust: `crate::i18n::tr`).
- Files kebab-case, components PascalCase, Rust modules snake_case.

## Agent Practices
- Do not start dev servers unless asked. Never edit `apps/desktop/src/utils/tauri.ts` (generated).
- Keep Taple free and local-only: no accounts, paywalls, cloud uploads or analytics.
- Commits use conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`).
