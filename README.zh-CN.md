<p align="center"><img src="app-icon.png" width="96" alt="Taple"></p>

# Taple

[English](README.md) | 简体中文

专门录产品演示和教程的开源 Mac 录屏工具，免费使用：录完直接剪辑、放大重点、加字幕、降噪，导出成视频或 GIF。也可以让 AI 先帮你粗剪一遍，或者用 Claude Code、Codex 这类 AI Agent 来剪。

**下载 macOS 版：[GitHub Releases](https://github.com/stimQQ/taple/releases/latest)**（需要 macOS 13.1 或更新版本）

## 功能

- **录屏**：录整个屏幕、单个窗口或框选区域，可以同时录摄像头画面、麦克风和系统声音
- **剪辑**：录完自动打开剪辑器，可以裁剪、调整画面和背景
- **AI 字幕**：用 Whisper 在本机生成字幕，不需要联网
- **降噪**：用 DeepFilterNet 去掉录音里的环境噪音
- **AI 剪辑**：填入 apimodels.app、Anthropic 或 OpenAI 的密钥后，AI 会剪掉口头禅和长停顿、加放大和字幕，但只要画面上有操作就不会剪。每处改动都显示在时间轴上，可以撤销
- **接入 AI Agent**：在「设置 → AI 剪辑 → 接入 Agent」里一键连接 Claude Code、Codex、Claude Desktop 或 Cursor，通过 MCP 让 Agent 帮你剪
- **导出**：导出 MP4 或 GIF 文件，或者直接复制到剪贴板
- **中英双语**：界面语言跟随系统，中文系统显示中文，其他系统显示英文

## 项目结构

这是一个 Turborepo monorepo：

| 目录 | 内容 |
|---|---|
| `apps/desktop` | Mac 桌面应用（Tauri v2 + SolidStart），负责录制和剪辑 |
| `apps/website` | 官网 taple.app 的静态页面 |
| `apps/cli` | 命令行工具（Rust） |
| `crates/*` | 录制、编码、渲染、摄像头等 Rust 模块 |
| `packages/ui-solid` | 共享的 SolidJS 组件、图标和样式 |
| `patches/libDF` | 降噪库 DeepFilterNet 的修改版 |

## 开发

需要 Node 20 或更新版本、pnpm 10、Rust，以及 Xcode。

```bash
pnpm install
pnpm env-setup      # 生成 .env
pnpm cap-setup      # 下载 FFmpeg 等原生依赖

# 桌面应用
pnpm dev:desktop
```

常用命令：`pnpm lint`（Biome 检查）、`pnpm format`（格式化）、`pnpm typecheck`（TypeScript 类型检查）、`cargo fmt --all`（Rust 格式化）。
更多说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布

在 GitHub Actions 里手动运行 `publish` 工作流，会自动构建、签名、公证并发布新版本。

## 致谢和许可证

Taple 基于 Cap Software, Inc. 开发的开源项目 [Cap](https://github.com/CapSoftware/Cap) 修改而来，感谢 Cap 团队。

和 Cap 一样，本项目以 [AGPLv3](LICENSE) 发布，其中 `cap-camera*` 和 `scap-*` 系列模块使用 [MIT 许可证](licenses/LICENSE-MIT)。
按照 AGPLv3 的要求，基于本项目分发或提供网络服务时，需要同样公开你修改后的源代码。
