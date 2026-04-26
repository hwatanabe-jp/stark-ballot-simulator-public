# Playwright E2E Tests

このディレクトリには、ブラウザ上で投票フローを通し確認する Playwright suite と、その Page Object / helper が入っています。コードがドキュメントより優先です。動かし方や selector の使い方で迷ったら、`package.json`、`playwright.config.ts`、`tests/e2e/*.spec.ts` を先に確認してください。

## 現在の構成

### Spec files

- `voting-flow.spec.ts`
  S0-S5 の投票→集計→検証フローを確認します。`@smoke` は現在 S0 と S2 です。S0 では正常系の verify 完走を、S2 では claimed tally tamper 時に `counted_tally_consistent=failed` かつ `stark_receipt_verify=success` / `stark_verification=success` になることを確認します。
- `a11y.spec.ts`
  `@axe` タグ付きのアクセシビリティ smoke です。対象は `/vote`, `/aggregate`, `/privacy`, `/terms` です。
- `legal-pages.spec.ts`
  `/privacy` と `/terms` の UI 表示・導線・言語切替を確認します。

### Page objects

- `BasePage`: 共通の page/localStorage helper
- `HomePage`: ホーム画面の開始導線
- `VotePage`: 投票選択と Bot 投票待機
- `AggregatePage`: シナリオ選択と finalize 実行
- `ResultPage`: tally 表示と verify 遷移
- `VerifyPage`: verify 画面の summary / check 状態取得

## 実行コマンド

```bash
# 全 Playwright suite（@axe を含む）
pnpm test:e2e

# Mock zkVM 用の通常 E2E（@axe は除外）
pnpm test:e2e:mock

# CI と同じ smoke 実行
pnpm test:e2e:mock --grep @smoke --reporter=list

# axe smoke のみ
pnpm test:e2e:axe

# デバッグ系
pnpm test:e2e:ui
pnpm test:e2e:headed
pnpm test:e2e:debug
pnpm test:e2e:report
```

### Real zkVM について

現時点では `pnpm test:e2e:real-dev` / `pnpm test:e2e:real-prod` の wrapper script はありません。`playwright.config.ts` には real-zkVM 用の分岐が残っていますが、定常運用の入口としてはメンテしていません。実証明の再確認は通常、以下の CLI 経路を使ってください。

```bash
pnpm test:cli:real-dev
pnpm test:cli:real-prod:s0
```

## CI の現状

- 公開 snapshot の自動実行は `.github/workflows/public-ui-mock-e2e.yml` です。
- ここで `pnpm test:e2e:axe` と `pnpm test:e2e:mock --grep @smoke --reporter=list` を実行します。
- `pnpm test:e2e:axe` は現在 `/vote`, `/aggregate`, `/privacy`, `/terms` の high-impact (`serious` / `critical`) axe violation を確認する smoke です。
- この smoke セットは現在 S0 と S2 で、正常系と「proof は正しいが claimed tally は壊れている」系の両方をカバーします。
- 公開 CI は生成済み public workflow だけを使い、private repository の build artifact には依存しません。

## Playwright 設定の前提

- active project は `chromium` のみです。
- `workers` は `1` 固定です。`fullyParallel: true` は定義されていますが、現行設定では実質直列実行です。
- mock 実行時は `webServer.command` が `scripts/start-test-server.sh` を使い、production build の `next start` を立ち上げます。
- failure 時は Playwright 標準の screenshot / video が残ります。trace は `trace: 'on-first-retry'` のため、retry が走ったケースで残ります。

## 検証戦略

`voting-flow.spec.ts` は mock Bot 投票のランダム性に依存しないよう、UI 表示の合計整合性を確認します。

```typescript
const tallySum = tallyCounts.reduce((sum, count) => sum + count, 0);
expect(tallySum).toBe(totalVotes);
```

このため、mock 環境では選択肢ごとの固定分布ではなく、総数と verify check の整合性を見ます。

さらに smoke では verify 画面の `data-status` を読み、S0 で `counted_expected_vs_tree_size` / `counted_election_manifest_consistent` / `counted_close_statement_consistent` / `stark_receipt_verify` の success を、S2 で `counted_tally_consistent` failed と `stark_verification` success を確認します。

## `data-testid` の使い方

### 基本ルール

1. 既存の命名規約に合わせる（例: `vote-option-A`, `scenario-radio-S0`, `check-counted_missing_indices_zero`）
2. 役割が分かる名前にする
3. テキスト内容ではなく、安定した属性で引く

### 現行パターン

#### Vote / Aggregate / Result

```tsx
<label data-testid="vote-option-A">...</label>
<button data-testid="execute-button">...</button>
<span data-testid="tally-value-A">14 票</span>
```

```typescript
await page.getByTestId('vote-option-A').click();
await page.getByTestId('execute-button').click();
const text = await page.getByTestId('tally-value-A').textContent();
```

#### Verification checks

verify UI は子要素の `check-status` ではなく、各 check 本体に `data-testid` と `data-status` を持たせています。

```tsx
<button data-testid={`check-${item.checkId}`} data-status={item.status}>
  ...
</button>
```

```typescript
const locator = page.getByTestId('check-counted_missing_indices_zero');
const status = await locator.getAttribute('data-status');
```

### 避けたい selector

```typescript
page.locator('text=/Tamper.*YES|Tamper.*NO|改ざん.*あり|改ざん.*なし/i');
```

文言・i18n・strict mode に弱いので、まず `data-testid` と `data-status` を検討してください。

## 実行環境と mock store

`pnpm test:e2e:mock` / `pnpm test:e2e:axe` は `package.json` で以下を事前セットします。

- `NEXT_PUBLIC_TURNSTILE_BYPASS=1`
- `TURNSTILE_BYPASS=1`
- `RUNTIME_DEPLOYMENT_ENV=develop`
- `DISABLE_STRICT_CSP=1`
- `USE_MOCK_ZKVM=true`
- `USE_MOCK_STORE=true`

さらに `scripts/start-test-server.sh` が mock 用の production server 起動前に以下を補完します。

- `ALLOW_INSECURE_ZKVM=true` を必要時に付与
- `VERIFIER_PUBLIC_BASE_URL=http://localhost:3000` を既定化
- `SESSION_CAPABILITY_SECRET` が未設定なら `scripts/tests/.env.test.defaults` の test-only 値を補完
- `PERSIST_MOCK_STORE=1` を有効化
- `FINALIZE_ASYNC_MODE=false` を固定
- `.tmp/mock-sessions/` を掃除してから起動

重要なのは、Playwright の mock 実行は production build + file-backed mock store 前提だという点です。`USE_MOCK_STORE=true` でも、この経路では in-memory ではなくファイル永続化が使われます。

## FileMockSessionStore cache controls

長時間の CLI / Playwright 実行で `.tmp/mock-sessions/` のメモリ使用量とディスク I/O を抑えるため、FileMockSessionStore には `lastActivity` とアクセス順を使うキャッシュ層があります。

- `FILE_STORE_CACHE_LIMIT`（デフォルト `32`）
- `DISABLE_FILE_STORE_CACHE=1`
- `FILE_MOCK_STORE_DIR`

`FileMockSessionStore.__getDiagnosticsForTests()` で `cacheSize` / `cacheEvictions` を確認できます。

## CSP 緩和と Turnstile bypass

headless E2E では strict CSP と Turnstile がそのままだと初期化を阻害することがあります。mock 用 script は必要な env を preset 済みです。Playwright を直接叩く場合も、少なくとも以下は mock UI テストと合わせてください。

- `DISABLE_STRICT_CSP=1`
- `NEXT_PUBLIC_TURNSTILE_BYPASS=1`
- `TURNSTILE_BYPASS=1`
- `RUNTIME_DEPLOYMENT_ENV=develop`

本番運用ではこれらを設定しません。

## 出力物

- HTML report: `playwright-report/`
- JSON report: `test-results/results.json`
- manual failure screenshot (`voting-flow.spec.ts`): `test-results/failure-*.png`
- trace / video / Playwright attachments: `test-results/` 配下

`test-results/screenshots/` は `BasePage.takeScreenshot()` を明示的に呼んだときだけ使われます。現行 spec の標準フローでは常用していません。
