# 単体・結合・E2E テスト

このページでは、example-based tests がどのリスクを守っているかを整理します。ここでの中心はテスト数ではなく、検証アプリとして失敗してはいけない境界に、どの層のテストを置いているかです。

## テストピラミッド

### 単体テスト

単体テストは、純粋関数や小さな UI component、schema、環境変数 guard、エラー整形の退行検出に使います。

主な対象:

- 検証チェック定義と summary logic
- Lean 生成 vector と照合する verification summary / display / check definition
- zkVM journal / input commitment / bitmap helper
- session capability token と Turnstile bypass guard
- UI component と hooks
- i18n translation consistency

### 結合テスト

結合テストは、境界をまたいだ契約が崩れていないかを検査します。

主な対象:

- Next / Hono で共有する API route registry
- store 実装と finalization state transition
- verification bundle の public allowlist
- verifier-service client と STARK receipt status の扱い
- Lean 生成 vector と照合する input commitment / bitmap Merkle / Rust guest model
- bitmap proof、bulletin proof、verification run などの session-scoped API

### CLI / E2E テスト

CLI と Playwright は、単一関数ではなく利用者フローとしての正しさを見ます。

- CLI flow: session 作成、投票、集計、検証をブラウザなしで実行する
- Playwright mock flow: production-mode の Next test server 上で主要画面を通す
- axe smoke: 主要ページの重大な accessibility violation を検出する
- real zkVM dev / prod flow: proof contract 変更時に mock だけで完了扱いにしないための重い確認経路

## 主なコマンド

| コマンド                            | 目的                                             |
| ----------------------------------- | ------------------------------------------------ |
| `pnpm test:run`                     | Vitest による単体・結合テスト                    |
| `pnpm test:public`                  | public snapshot 向けの安全なテスト subset        |
| `pnpm test:cli:mock`                | mock zkVM / mock store で CLI voting flow を実行 |
| `pnpm test:e2e:mock`                | Playwright によるブラウザ E2E                    |
| `pnpm test:e2e:axe`                 | axe accessibility smoke                          |
| `pnpm test:cli:real-dev`            | `RISC0_DEV_MODE=1` の real zkVM 接続 smoke       |
| `pnpm test:cli:real-prod:s0`        | S0 の production STARK proof flow                |
| `pnpm formal:verify`                | Lean build / formal vector drift guard           |
| `pnpm build:zkvm`                   | zkVM guest / host の build                       |
| `pnpm build:verifier-service`       | Rust verifier-service の build                   |
| `cd verifier-service && cargo test` | verifier-service の Rust tests                   |
| `cd zkvm && cargo test`             | zkVM / contract-core 側の Rust tests             |

`RISC0_DEV_MODE=1` の receipt は production STARK proof ではありません。UI/API の回帰検出には有用ですが、proof soundness を確認したことにはなりません。

## 重要な検査観点

### Verified を誤表示しない

このアプリの最重要 invariant は、必要な暗号・整合性チェックが通っていない状態で `Verified` を表示しないことです。

テストでは次のような状態を fail-closed に扱います。

- required check が `failed`
- required check が `not_run` / `pending` / `running`
- STARK receipt verification が失敗または未解決
- unknown check や空の check set
- `excludedSlots > 0`
- public tally と verified tally の不一致

この観点は [ゲーティングロジック](../verification/gating-logic.md) の実装側の安全網です。

### 公開 artifact 境界

`bundle.zip` は第三者検証に必要な公開可能 artifact だけを含みます。

公開してよいものは allowlist で管理し、次の artifact は配布対象に含めません。

- `input.json`
- `verification.json`
- `included-bitmap.json`
- `seen-bitmap.json`

この境界は sync 生成、async container、bundle/report delivery の複数箇所にまたがるため、テストで契約として固定します。

### mock / real zkVM 境界

mock zkVM は UI や API flow の高速な退行検出に使います。一方で、journal format、input commitment、Image ID、receipt verification contract に触れる変更では、Rust 側や real zkVM 経路を使って TypeScript と Rust の対応を確認します。

コストの違いを前提に、普段は軽い gate を使い、proof contract に触れる変更では重い gate へ進む設計です。

### UI と accessibility

Playwright は、ユーザーが実際に触る投票・集計・検証の流れを production-mode server 上で確認します。テスト ID は翻訳文ではなく安定した `data-testid` を使い、i18n やレイアウト変更に引きずられにくくしています。

## CI での位置づけ

CI では、TypeScript の core checks、UI mock E2E、Rust tests、formal checks、public snapshot checks が役割を分けて動きます。

すべてを常に最重構成で走らせるのではなく、変更領域に応じて必要な gate を選ぶ構成にしています。特に production STARK proof は高コストなので、proof 入力や journal contract に関わる変更で使う確認経路として扱います。

<!-- source: package.json, vitest.config.ts, playwright.config.ts, tests/e2e/, tests/e2e/README.md, scripts/tests/cli-e2e-voting-flow.ts, scripts/tests/README.md, formal/**, scripts/formal/**, docs/current/formal/generated-vectors/**, src/**/*.test.ts, src/**/*.test.tsx, CI workflow definitions -->
