# RISC Zero セットアップガイド

このガイドでは、STARK Ballot Simulatorで使用するRISC Zero zkVMの開発環境を、**このリポジトリのバージョンに合わせて**セットアップする手順を説明します。

## 前提条件

- Linux/macOS/WSL2
- インターネット接続（ツールチェーンのダウンロードが発生します）
- 十分なディスク容量（数GB）
- `rustup` が利用可能

## 1. Rustツールチェーンのインストール

このリポジトリは `rust-toolchain.toml` で Rust **1.91.1** を固定しています。

```bash
rustup toolchain install 1.91.1
rustup component add rustfmt clippy --toolchain 1.91.1
rustc --version
```

`rustc --version` が `1.91.1` になっていればOKです。

## 2. cargo-risczero のインストール

RISC Zero のツールは `cargo-risczero` を使います。プロジェクトの依存と揃えるため **3.0.5** を明示的に入れます。

```bash
cargo install --locked cargo-risczero --version 3.0.5
cargo risczero --version
```

`cargo risczero --version` で `3.0.5` が表示されればOKです。

## 3. RISC Zero ツールチェーンのインストール

```bash
cargo risczero install
```

初回はダウンロードとビルドで時間がかかります。

## 4. このリポジトリの zkVM をビルド

```bash
# ルートから
pnpm build:zkvm

# もしくは zkvm/ 直下で
cd zkvm
cargo build --release
```

## 5. 動作確認（任意）

```bash
cd zkvm
RISC0_DEV_MODE=1 ./target/release/host test-data/test-fixture-valid.json
```

## トラブルシューティング

### `cargo risczero install` が失敗する

- まず `cargo-risczero` のバージョンが 3.0.5 であることを確認してください。
- それでも失敗する場合は、エラーメッセージの指示に従って再実行してください。

### ARM64 Linux で時間がかかる / 失敗する

ARM64 Linux ではプリビルドツールチェーンが利用できない場合があり、ビルドに長時間かかることがあります。

## 参考リンク

- [RISC Zero公式ドキュメント](https://dev.risczero.com/)
- [RISC Zero GitHub](https://github.com/risc0/risc0)
- `zkvm/README.md`
