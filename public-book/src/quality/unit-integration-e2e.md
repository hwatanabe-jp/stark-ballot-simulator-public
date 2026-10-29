# 単体、結合、E2E テスト

S1 の一票除外では、集計関数による欠落の検出に加え、その情報が API を通ってブラウザに届き、画面で成功表示が抑止されることまで確認が必要です。

## 各テストの対象範囲

単体テストでは、入力コミットメントの計算、ジャーナルの読み取り、最終判定などを小さく切り出して確かめます。たとえば必須チェックを `failed` にしたときや、未知のチェックを混ぜたときに、完全成功を返さないことを検査します。

結合テストでは、処理間の連携に誤りがないかを確認します。投票と集計の状態遷移、API の要求・応答、保存した証拠の読み出し、Rust 検証サービスが返す状態などが対象です。公開 ZIP の許可リストも、生成側と配布側の両方で守られているかを確かめます。

CLI テストはブラウザを使わずに、セッション作成から投票、集計、検証までを実行します。Playwright の E2E テストは画面を操作し、同じ流れが利用者の操作として成立するかを確認します。アクセシビリティ検査には axe も使います。

## mock・開発用レシート・本番証明の使い分け

日常の画面開発では mock の証明を使い、短時間で失敗を見つけます。一方、証明の入力・出力形式、Image ID、レシート検証の条件を変更した場合は、実際の production STARK 証明を通す必要があります。

| コマンド                     | 確かめるもの                               |
| ---------------------------- | ------------------------------------------ |
| `pnpm test:run`              | リポジトリ全体の Vitest 単体・結合テスト   |
| `pnpm test:public`           | 公開ソースに含める範囲のテスト             |
| `pnpm test:cli:mock`         | mock 証明を使う API の一連の流れ           |
| `pnpm test:e2e:mock`         | ブラウザから操作する一連の流れ             |
| `pnpm test:e2e:axe`          | 主な画面のアクセシビリティ                 |
| `pnpm test:cli:real-dev`     | 実際の zkVM と開発用レシートを使う接続確認 |
| `pnpm test:cli:real-prod:s0` | S0 の production STARK 証明を使う確認      |
| `pnpm rust:zkvm:test`        | Rust のゲスト・共有契約のテスト            |
| `pnpm rust:verifier:test`    | Rust 検証サービスのテスト                  |
| `pnpm formal:verify`         | Lean の成果物と TypeScript テストの対応    |

開発用レシートが通ることは、production STARK 証明が検証できることの証拠にはなりません。テスト結果を見るときも、どの証明を使った実行かを区別します。

## mock E2E のサーバー構成

`pnpm dev` は Vite の開発サーバーとブラウザ内の mock API を使います。これに対して mock E2E は、production モードでビルドしたフロントエンドを静的 Hono サーバーから配信し、同じオリジンの API を呼び出します。画面だけでなく、HTTP と保存処理までつながる点が違います。

| コマンド                                   | API・保存・証明                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `pnpm dev`                                 | ブラウザ内 mock API。サーバーを使う場合はメモリ保存・同期処理・mock 証明 |
| `pnpm test:e2e:mock` / `pnpm test:e2e:axe` | Hono API・ファイル保存・同期処理・mock 証明                              |

保存方式と証明の組は、[実行プロファイル](../aws/runtime-boundary.md#実行プロファイル)に定義します。

E2E の起動スクリプトがブラウザとサーバーのプロファイルを揃えます。AWS 向けの `pnpm build:ci` では `target-aws-async` を選び、出力に mock API やテスト用の Turnstile 回避処理が混入していないことも検査します。

## テスト配置と実行対象の検査

Vitest のテストは対象実装のそばに置き、Playwright のテストは `tests/e2e/` に置きます。各ワークスペースとリポジトリ用ツールが担当するテストを明示し、未発見や重複実行を検査します。ブラウザ環境の jsdom を使うのは web ワークスペースだけです。

各ワークスペースの `test` は狭い確認に使えますが、全体の単体・結合テストはルートの `pnpm test:run` で実行します。CI ではこれに画面テスト、Rust、形式化、公開ソースの検査を組み合わせます。

<!-- source: package.json, vitest.config.ts, tooling/workspace/workspace-metadata.ts, tooling/workspace/vitest-projects.test.ts, scripts/test-discovery/test-layout.ts, scripts/test-discovery/test-layout.test.ts, playwright.config.ts, tests/e2e/, tests/e2e/README.md, scripts/start-test-server.sh, scripts/tests/cli-e2e-voting-flow.ts, scripts/tests/README.md, formal/, scripts/formal/, docs/formal/generated-vectors/, apps/, packages/ -->
