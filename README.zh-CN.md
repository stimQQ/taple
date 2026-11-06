<p align="center"><img src="app-icon.png" width="96" alt="Taple"></p>

# Taple

[English](README.md) | 简体中文

开源的 Mac 录屏和剪辑工具：录完直接剪辑、加字幕、降噪，导出成视频或 GIF。

**下载 macOS 版：[GitHub Releases](https://github.com/stimQQ/taple/releases/latest)**（需要 macOS 13.1 或更新版本）

## 功能

- **录屏**：录整个屏幕、单个窗口或框选区域，可以同时录摄像头画面、麦克风和系统声音
- **剪辑**：录完自动打开剪辑器，可以裁剪、调整画面和背景
- **AI 字幕**：用 Whisper 在本机生成字幕，不需要联网
- **降噪**：用 DeepFilterNet 去掉录音里的环境噪音
- **导出**：导出 MP4 或 GIF 文件，或者直接复制到剪贴板
- **中英双语**：界面语言跟随系统，中文系统显示中文，其他系统显示英文

## 项目结构

这是一个 Turborepo monorepo：

| 目录 | 内容 |
|---|---|
| `apps/desktop` | Mac 桌面应用（Tauri v2 + SolidStart），负责录制和剪辑 |
| `apps/web` | Web 端（Next.js），负责分享页面和账号管理 |
| `apps/cli` | 命令行工具（Rust） |
| `crates/*` | 录制、编码、渲染、摄像头等 Rust 模块 |
| `packages/*` | 共享的数据库、UI 组件、工具函数等 |
| `patches/libDF` | 降噪库 DeepFilterNet 的修改版 |

## 开发

需要 Node 20 或更新版本、pnpm 10、Rust，以及 Xcode。

```bash
pnpm install
pnpm env-setup      # 生成 .env
pnpm cap-setup      # 下载 FFmpeg 等原生依赖

# 桌面应用
cd apps/desktop && pnpm dev

# Web 端
pnpm dev:web
```

常用命令：`pnpm lint`（Biome 检查）、`pnpm format`（格式化）、`pnpm typecheck`（TypeScript 类型检查）、`cargo fmt --all`（Rust 格式化）。
更多说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布

在 GitHub Actions 里手动运行 `publish` 工作流，会自动构建、签名、公证并发布新版本。

## 致谢和许可证

Taple 基于 Cap Software, Inc. 开发的开源项目 [Cap](https://github.com/CapSoftware/Cap) 修改而来，感谢 Cap 团队。

和 Cap 一样，本项目以 [AGPLv3](LICENSE) 发布，其中 `cap-camera*` 和 `scap-*` 系列模块使用 [MIT 许可证](licenses/LICENSE-MIT)。
按照 AGPLv3 的要求，基于本项目分发或提供网络服务时，需要同样公开你修改后的源代码。
