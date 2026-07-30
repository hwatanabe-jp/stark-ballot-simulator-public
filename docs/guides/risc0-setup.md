# RISC Zero セットアップガイド

このガイドでは、STARK Ballot Simulatorで使用するRISC Zero zkVMの開発環境を、**このリポジトリのバージョンに合わせて**セットアップする手順を説明します。

通常のローカル mock 開発では RISC Zero のセットアップは不要です。まず
[ルート README](../../README.md) の Node.js / pnpm 手順で `pnpm dev` を実行し、
実 zkVM または Rust 側の作業を行う場合だけ本ガイドを使用してください。

## 前提条件

- Linux/macOS/WSL2
- インターネット接続（ツールチェーンのダウンロードが発生します）
- 十分なディスク容量（数GB）
- `rustup` が利用可能

## 1. Rustツールチェーンのインストール

このリポジトリは `rust-toolchain.toml` で host Rust **1.97.1** を固定しています。

```bash
rustup toolchain install 1.97.1
rustup component add rustfmt clippy --toolchain 1.97.1
rustc --version
```

`rustc --version` が `1.97.1` になっていればOKです。

## 2. rzup のインストール

RISC Zero **3.0.6** と同じ release tag から `rzup` をインストールします。

```bash
cargo install --locked --git https://github.com/risc0/risc0 --tag v3.0.6 rzup
rzup --version
```

## 3. RISC Zero ツールチェーンのインストール

プリビルド済みのツールチェーンを利用できるプラットフォームでは、次を実行します。

```bash
rzup install rust 1.97.0
rzup install r0vm 3.0.6
rzup install cargo-risczero 3.0.6
cargo risczero --version
```

host Rust `1.97.1` と guest toolchain は別物です。`rzup install rust
1.97.0` は RISC Zero の guest toolchain tag `r0.1.97.0` を選びます。
存在しない `r0.1.97.1` を選ばないでください。初回はダウンロードと
ビルドで時間がかかります。

ARM64 Linux でプリビルド済みツールチェーンを利用できない場合は、
後述の [ARM64 Linux 向け手順](#arm64-linux-で時間がかかる--失敗する) を使用してください。

## 4. このリポジトリの zkVM をビルドして動作確認

用途に合わせて、次のどちらか一方を選びます。

### 開発用スモークテスト

ルートから dev-mode 対応の host をビルドし、`RISC0_DEV_MODE=1` で実行します。

```bash
pnpm build:zkvm:dev-mode
RISC0_DEV_MODE=1 ./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json
```

`zkvm/` 直下で Cargo を使用する場合は、`production` feature を付けません。

```bash
cd zkvm
cargo build --release -p host
RISC0_DEV_MODE=1 ./target/release/host test-data/test-fixture-valid.json
```

このモードが生成するのは fake receipt であり、production STARK proof ではありません。

### Production proof

ルートから production feature を有効にしてビルドし、`RISC0_DEV_MODE` を
設定せずに実行します。

```bash
pnpm build:zkvm
unset RISC0_DEV_MODE
./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json
```

`zkvm/` 直下で Cargo を使用する場合は、次のとおりです。

```bash
cd zkvm
cargo build --release -p host --features production
unset RISC0_DEV_MODE
./target/release/host test-data/test-fixture-valid.json
```

このモードは実際の STARK proof を生成するため、完了まで数分以上かかることがあります。

## トラブルシューティング

### `rzup install` が失敗する

- まず `rzup` を RISC Zero `v3.0.6` tag からインストールしたことを確認してください。
- guest Rust には `1.97.0` を指定し、host Rust `1.97.1` と混同しないでください。
- それでも失敗する場合は、エラーメッセージの指示に従って再実行してください。

### ARM64 Linux で時間がかかる / 失敗する

ARM64 Linux ではプリビルド済みツールチェーンを利用できない場合があります。
その場合は、`cmake`、`ninja`、`clang` などのビルド依存をインストールしたうえで、
RISC Zero `v3.0.6` のソースから guest Rust と `cargo-risczero` をビルドします。

```bash
git clone --branch v3.0.6 --depth 1 \
  https://github.com/risc0/risc0.git risc0-v3.0.6
cd risc0-v3.0.6
test "$(git rev-parse HEAD)" = "1cc70cf05033a79ebc90f07c679cb4bd1cd301b9"
rzup build --tag-or-commit r0.1.97.0 rust
cargo +1.97.1 install --path risc0/cargo-risczero --locked
cargo risczero --version
r0vm --version
```

guest Rust のソースビルドには時間がかかります。必要なパッケージと手順の
基準は [`Dockerfile.risc0-toolchain-arm64`](../../infra/docker/Dockerfile.risc0-toolchain-arm64)
を参照してください。

## 参考リンク

- [RISC Zero公式ドキュメント](https://dev.risczero.com/)
- [RISC Zero GitHub](https://github.com/risc0/risc0)
- [リポジトリ内の zkVM README](../../zkvm/README.md)
- [STARK 証明検証テスト](./stark-verification-testing.md)
- [zkVM 設計・証拠資料](../zkvm/README.md)
