<p align="center"><img src="app-icon.png" width="96" alt="Taple"></p>

# Taple

English | [简体中文](README.zh-CN.md)

Taple is a free, open source screen recorder for product demos and tutorials on macOS. Record your screen, camera and voice, then trim, zoom in, add captions and clean up the audio in the built-in editor before exporting to video or GIF. AI Edit can make the first cut for you, and AI agents like Claude Code and Codex can edit your recordings too. It is a fork of [Cap](https://github.com/CapSoftware/Cap).

**Download for macOS: [GitHub Releases](https://github.com/stimQQ/taple/releases/latest)** (requires macOS 13.1 or later)

## Features

- **Recording**: capture the whole screen, a single window or a selected area, together with your camera, microphone and system audio
- **Editing**: the editor opens as soon as you stop recording, so you can trim clips and adjust the frame and background
- **AI captions**: captions are generated on your Mac with Whisper, with no internet connection required
- **Noise reduction**: DeepFilterNet removes background noise from your recordings
- **AI Edit**: with an apimodels.app, Anthropic or OpenAI key, AI cuts filler words and long pauses, adds zooms and captions, and keeps every moment where something happens on screen. Every change shows up on the timeline and can be undone
- **AI agents**: connect Claude Code, Codex, Claude Desktop or Cursor in one click (Settings → AI Edit → AI Agents) and edit recordings from your agent over MCP
- **Export**: save as MP4 or GIF, or copy straight to the clipboard
- **English and Chinese**: the interface follows your system language

## Project structure

This is a Turborepo monorepo:

| Directory | Contents |
|---|---|
| `apps/desktop` | The macOS app (Tauri v2 + SolidStart) for recording and editing |
| `apps/website` | The static website for taple.app |
| `apps/cli` | Command line tool (Rust) |
| `crates/*` | Rust crates for recording, encoding, rendering, cameras and more |
| `packages/ui-solid` | Shared SolidJS components, icons and styles |
| `patches/libDF` | A modified copy of the DeepFilterNet noise reduction library |

## Development

You need Node 20 or later, pnpm 10, Rust and Xcode.

```bash
pnpm install
pnpm env-setup      # create .env
pnpm cap-setup      # download FFmpeg and other native dependencies

# Desktop app
pnpm dev:desktop
```

Common commands: `pnpm lint` (Biome), `pnpm format`, `pnpm typecheck` (TypeScript) and `cargo fmt --all` (Rust).
See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

Desktop UI text follows the system language. Wrap every user-facing string as `L("中文", "English")` from `~/utils/i18n`.

## Releasing

Run the `publish` workflow in GitHub Actions. It builds, signs, notarizes and publishes a new release.

## Credits and license

Taple is based on [Cap](https://github.com/CapSoftware/Cap), the open source project by Cap Software, Inc. Thanks to the Cap team.

Like Cap, this project is released under [AGPLv3](LICENSE). The `cap-camera*` and `scap-*` crates use the [MIT license](licenses/LICENSE-MIT).
Under AGPLv3, if you distribute this project or offer it as a network service, you must also publish the source code of your modified version.
