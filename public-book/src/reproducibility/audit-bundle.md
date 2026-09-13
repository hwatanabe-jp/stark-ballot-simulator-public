# 手元で証拠を検証する（Ubuntu）

検証画面で取得した `bundle.zip` を、対応する公開ソースと照合します。長い検査処理はリポジトリの `scripts/docs/audit-bundle.sh` にまとめてあります。このスクリプトは、アプリと同じ ZIP 読み取り・データ検査・入力コミットメント計算を使い、STARK レシートの暗号検証には Rust の `verifier-service` を使います。

## 1. ソースとツールを用意する

検証したいリリースに対応する [公開ソース](https://github.com/hwatanabe-jp/stark-ballot-simulator-public) を取得し、そのルートで作業します。必要なのは Ubuntu 22.04 / 24.04、Node.js 24、Corepack、Rust と次のビルド用ツールです。

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev jq curl ca-certificates
corepack enable
pnpm install --frozen-lockfile
```

pnpm のバージョンはルートの `package.json` にある `packageManager` から Corepack が解決します。Rust がまだなければ導入します。

```bash
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"
```

リポジトリ内では `rust-toolchain.toml` が指定する Rust を使います。Rust の導入後も、以降のコマンドはリポジトリのルートで実行してください。

## 2. production 用の検証サービスを作る

```bash
cargo build --manifest-path verifier-service/Cargo.toml --release --features production
```

`production` feature は RISC Zero の開発モードを無効にします。生成先は `verifier-service/target/release/verifier-service` です。すでに別用途でビルドしたバイナリがあっても、このコマンドで production 用にビルドしてから監査します。

## 3. ZIP を検査する

ダウンロードした ZIP のファイル名に置き換えて実行します。

```bash
bash scripts/docs/audit-bundle.sh "$HOME/Downloads/stark-ballot-verification-REPLACE.zip"
```

期待する Image ID は通常 `variants.default` を使います。対象リリースが x86_64 向けの別ビルドを使った場合は、明示的に選びます。

```bash
bash scripts/docs/audit-bundle.sh "$HOME/Downloads/stark-ballot-verification-REPLACE.zip" x86_64
```

これは手元の CPU を自動判定する指定ではなく、**証明を生成したゲストビルド**の選択です。`public/imageId-mapping.json` の該当値が未確定なら処理は止まり、他の値で代用しません。

スクリプトは毎回新しい一時ディレクトリに ZIP をコピーし、六つの検査を順に実行します。失敗した場合はそこで停止します。最後に表示する `Audit files:` の場所には、対象 ZIP、展開したファイル、生成できた検証レポートが残ります。

## 実行中に確かめていること

| 検査            | 確認内容                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| 1. ZIP          | 同期・非同期いずれかの公開ファイル構成を満たし、不正なパス、重複、許可していないファイルがない       |
| 2. 期待値       | ジャーナルの方式が現行契約に合い、対応するソースから期待 Image ID を選べる                           |
| 3. 証明         | 検証サービスの終了コードとレポートが `0/success` で一致し、期待 Image ID と ZIP 名も一致する         |
| 4. 出力         | レシート内の出力を読み出すと `journal.json` の証明に結び付く全フィールドと一致し、票数の条件も満たす |
| 5. 選挙と掲示板 | 公開入力、選挙設定、締切宣言、ジャーナルの ID・ハッシュ・ルート・票数・STH が整合する                |
| 6. 入力         | 公開入力から再計算した `inputCommitment` が、ジャーナルの値と一致する                                |

ZIP は同じメモリ上のバイト列を検査してから展開します。ZIP 読み取り側は各ファイルの展開後サイズを 64 MiB、合計を 512 MiB、エントリー数を 10,000、パスを 4,096 バイトに制限し、CRC も確認します。そのうえで、実際に許可するファイル名と数を公開バンドルの規則で絞ります。

レシート検証では、レポートに `success` と書かれているだけでは通しません。共通のレポート読み取り処理が形式と終了コードの組を検査します。開発用の `2/dev_mode`、失敗の `3/failed`、その他の不一致は監査の成功にしません。

さらに `decode-journal` で同じレシートを再検証し、RISC Zero の形式で格納された出力を読み出します。比較するのは選挙 ID・設定ハッシュ、掲示板ルートと STH、各票数、候補別集計、ビットマップルート、入力コミットメント、方式のバージョンです。`receipt.json` の隣にある JSON を読んだだけでは、証明の出力を確認したことにならないためです。

票数については、`excludedSlots`、`missingSlots`、`invalidPresentedSlots` がゼロであること、`totalExpected = treeSize`、`totalVotes > 0`、候補別の `verifiedTally` 合計が `validVotes` と等しいことを確認します。位置数とレコード数の違いは [ゲストプログラム](../zkvm/guest-program.md) の定義に従います。

## 結果を読む

六つが通ると `Bundle audit passed` と表示します。これは「手元で検証した証明と、この ZIP の公開データが、上記の条件で整合した」という結果です。S1 の票の欠落は位置の検査で失敗します。一方、S2 のように画面へ渡す集計表示だけを変更した場合、ZIP の監査は通り得ます。[画面に必要な追加の証拠](index.md#画面の結果との違い) まで揃えて初めて、画面の最終判定と比較できます。

失敗した場合は、表示された検査番号とエラー、`Audit files:` にある対象データを確認します。期待値を受け取った ZIP の値に合わせたり、失敗した検査を省略したりして続行しないでください。再実行も同じコマンドで行えば、新しい監査ディレクトリが作られます。

<!-- source: scripts/docs/audit-bundle.sh, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/lib/verification-data.ts, apps/web/src/api/artifacts.ts, apps/api/src/server/api/handlers/verify.ts, apps/api/src/server/api/handlers/verificationBundles.ts, packages/node-adapters/src/verification-bundle.ts, packages/node-adapters/src/zip.ts, packages/verification/src/verification/public-bundle-manifest.json, packages/verification/src/verification/public-bundle-manifest.ts, packages/verification/src/verification/verification-bundle.ts, packages/verification/src/verification/public-audit-artifacts.ts, packages/verification/src/verification/verifier-service-report.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/engine/evaluate-checks.ts, infra/docker/entrypoint.sh, verifier-service/Cargo.toml, verifier-service/src/lib.rs, public/imageId-mapping.json, packages/zkvm-contract/src/zkvm/types.ts -->
