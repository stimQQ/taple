# Changelog

All notable changes to Taple are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). A Chinese version is in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## [Unreleased]

### Fixed

- Taple no longer opens by itself after you quit it. Claude Code, Codex, Claude Desktop and Cursor start Taple's MCP server whenever a new session begins, and that used to launch Taple. Taple now starts only when an AI agent actually calls one of its tools.

## [0.1.2] - 2026-11-11

### Fixed

- Connecting an AI agent in Settings → AI while Taple runs from the disk image or the Downloads folder no longer saves a location that stops working once the disk image is ejected or the app is moved. Taple now asks you to drag it into the Applications folder and open it from there first.

## [0.1.1] - 2026-11-08

### Added

- Taple checks for updates every time the main window opens and shows a banner when a new version is ready. Update downloads and installs it; the banner can be dismissed until the next launch.
- The first time you open Taple, it downloads the speech model (Whisper Small, about 466 MB) in the background, so captions, AI Edit and AI agents work right away.
- If the speech model is missing, AI Edit and the `transcribe` tool for AI agents download it on demand and show the progress, instead of asking you to find the download button in the Captions tab.

### Changed

- The update screen shows checking, download progress, installing and restart states. When an update fails it explains why and offers Try Again and Back, and it offers Back when Taple is already up to date.
- Speech model downloads show real progress, resume after a dropped connection, and are checked against the expected size and SHA-256 before use. Model files come from a pinned Hugging Face revision.
- Clicking the scene track now adds a segment that hides the camera. Select the segment to show the camera full screen instead.
- The empty scene track hint now describes the new default.

### Fixed

- The close button on the camera preview now turns the camera off. Before, the main window turned the camera back on a few milliseconds later.
- Choosing No Camera or No Microphone in the main window now sticks, including after a restart. The first camera and microphone are selected automatically only if you have never chosen one.
- Turning on Hide Camera no longer makes the preview jump. The scene track stays in place, dimmed, instead of disappearing.
- Scene segments no longer blur the screen while the camera is hidden, in the preview and in exports.
- A download interrupted in an earlier version no longer leaves a broken model file that looked downloaded.
- The Captions tab no longer restores a stale download state from a previous session.

## [0.1.0] - 2026-11-07

The first release of Taple, a free, open source screen recorder for product demos and tutorials on macOS. Taple is a fork of [Cap](https://github.com/CapSoftware/Cap).

### Added

- Record the whole screen, a window or an area, together with your camera, microphone and system audio.
- The editor opens as soon as you stop recording. Trim, change the speed, zoom in, and adjust the frame and background.
- Captions are generated on your Mac with Whisper. Pick from 24 downloadable fonts and add an outline.
- Audio cleanup removes background noise with DeepFilterNet and sets your voice to a steady -16 LUFS. You can restore the original audio at any time, and the editor swaps the audio without reloading.
- AI Edit: add an apimodels.app, Anthropic or OpenAI key and AI Edit cuts filler words and long pauses, speeds up waiting, adds zooms and fixes captions, while keeping every moment where something happens on screen. Each change shows up on the timeline, and the whole run is one undo step.
- AI agents: connect Claude Code, Codex, Claude Desktop or Cursor in one click (Settings → AI Edit → AI Agents) and let your agent edit recordings through Taple's MCP server with the same rules as AI Edit.
- Send feedback and read the changelog inside the app.
- Export to MP4 or GIF, or copy the video to the clipboard.
- The interface follows your system language: Chinese on Chinese systems, English everywhere else.
- Builds for Apple silicon and Intel Macs, signed and notarized, with automatic update packages.

### Changed

- Renamed from SparkVideo to Taple. New recordings are saved as `.taple`, and `.sparkvideo` and `.cap` projects still open.
- Free and local-only: no accounts, no paid plans, no cloud sharing and no analytics in official builds.
- The welcome screen is gone. The setup window only appears when screen recording or accessibility permission is missing.
- Mono microphone audio is mixed louder, the default microphone volume is +20 dB, and a soft limiter keeps the final mix from clipping.

### Privacy

- AI Edit sends the transcript, still frames and click timing to the provider you choose. Your video and audio files stay on your Mac. API keys are stored in the macOS Keychain.

[Unreleased]: https://github.com/stimQQ/taple/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/stimQQ/taple/releases/tag/v0.1.2
[0.1.1]: https://github.com/stimQQ/taple/releases/tag/v0.1.1
[0.1.0]: https://github.com/stimQQ/taple/releases/tag/v0.1.0
