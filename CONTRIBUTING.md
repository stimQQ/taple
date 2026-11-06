# Contributing

Issues and pull requests are welcome.

## Setup

You need Node 20 or later, pnpm 10, Rust and Xcode.

```bash
pnpm install
pnpm env-setup      # create .env
pnpm cap-setup      # download FFmpeg and other native dependencies
pnpm dev:desktop
```

## Before you submit

- `pnpm format`: format TypeScript with Biome
- `pnpm lint`: lint with Biome
- `pnpm typecheck`: TypeScript type check
- `cargo fmt --all`: format Rust code
- `cargo clippy`: lint Rust code

## Notes

- `apps/desktop/src/utils/tauri.ts` and `queries.ts` are generated from Rust types. Do not edit them by hand
- The desktop UI follows the system language. Wrap every user-facing string as `L("中文", "English")` from `~/utils/i18n`, and use `crate::i18n::tr` in Rust
- `patches/libDF` is a modified copy of the DeepFilterNet noise reduction library. It keeps the upstream formatting and is excluded from `cargo fmt`

## License

By contributing, you agree that your code is released under the project's [AGPLv3 license](LICENSE).
