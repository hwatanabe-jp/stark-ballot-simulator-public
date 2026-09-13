# Playwright E2E Tests

このディレクトリには、ブラウザ上で投票フローを通し確認する Playwright suite と、その Page Object / helper が入っています。コードがドキュメントより優先です。動かし方や selector の使い方で迷ったら、`package.json`、`playwright.config.ts`、`tests/e2e/*.spec.ts` を先に確認してください。

## 現在の構成

### Spec files

- `voting-flow.spec.ts`
  S0-S5 の投票→集計→検証フローを確認します。`@smoke` は現在 S0 と S2 です。mock S0 では正常系の verify が `demo_only` で完了することを、S2 では claimed tally tamper 時に `counted_tally_consistent=failed` かつ `stark_receipt_verify=success` / `stark_verification=success` になることを確認します。
- `a11y.spec.ts`
  `@axe` タグ付きのアクセシビリティ smoke です。対象は `/vote`, `/aggregate`, `/privacy`, `/terms` です。
- `legal-pages.spec.ts`
  `/privacy` と `/terms` の UI 表示・導線・言語切替を確認します。
- `knowledge-panel.spec.ts`
  解説グループの開閉、キーボードフォーカス、狭幅への変更後も開閉状態が保たれることを確認します。通常時と動きを減らす設定の両方で、登場・開閉アニメーションがないことを検証します。
- `voting-performance.spec.ts`
  `@benchmark` タグ付きの性能測定です。通常の suite から除外し、`pnpm test:e2e:benchmark` で明示実行します。

### Page objects

- `BasePage`: 共通の page navigation helper
- `HomePage`: ホーム画面の開始導線
- `VotePage`: 投票選択と Bot 投票待機
- `AggregatePage`: シナリオ選択と finalize 実行
- `ResultPage`: tally 表示と verify 遷移
- `VerifyPage`: verify 画面の summary / check 状態取得

## 実行コマンドと runtime profile

定常運用で test を実行する Playwright command はすべて `static-mock-e2e` profile を選択します。
この profile は production build の frontend と同一 origin の local Hono API を使い、
mock proof を E2E evidence として扱います。

```bash
# 通常の全 Playwright suite（@axe を含む、benchmark を除く）
pnpm test:e2e

# Mock zkVM 用の通常 E2E（@axe は除外）
pnpm test:e2e:mock

# CI と同じ全 mock 実行（S0-S5 を含む）
CI=true pnpm test:e2e:mock

# ローカルの短い smoke 実行（S0 と S2）
pnpm test:e2e:mock --grep @smoke --reporter=list

# axe smoke のみ
pnpm test:e2e:axe

# 性能測定のみ（固定の時間閾値を評価）
pnpm test:e2e:benchmark

# デバッグ系
pnpm test:e2e:ui
pnpm test:e2e:headed
pnpm test:e2e:debug
pnpm test:e2e:report
```

`playwright.config.ts` の production-build harness は `local-proof-development` と
`local-proof-production` も解決できますが、`pnpm test:e2e:real-dev` /
`pnpm test:e2e:real-prod` の wrapper script はありません。real zkVM evidence の
定常確認は以下の CLI 経路です。

```bash
pnpm test:cli:real-dev
pnpm test:cli:real-prod:s0
```

## CI の現状

- 公開 snapshot の自動実行は `.github/workflows/public-ui-mock-e2e.yml` です。
- `pnpm test:e2e` で mock S0-S5・legal pages・Axe smoke を一括実行します。benchmark は通常実行から除外します。
- 一つの job で container・依存 install・mock frontend build・test server を共有します。
- HTML / JSON / console report と失敗時の trace を保存します。

## Playwright harness と mock runtime

- active project は `chromium` のみです。
- `workers` は `1` 固定です。`fullyParallel: true` は定義されていますが、現行設定では実質直列実行です。
- failure 時は Playwright 標準の screenshot / video が残ります。trace は `trace: 'on-first-retry'` のため、retry が走ったケースで残ります。
- server は Playwright の `webServer` が専用ポート `3100` で起動・終了し、既存 server は再利用しません。`pnpm dev` のポート `3000` と分離しています。
- 画面の準備完了は URL と対象要素の表示・操作可能状態で待機します。
- benchmark command は `PLAYWRIGHT_BENCHMARK=1` で専用 spec を有効化し、`@benchmark` のみ選択します。測定値を JSON attachment として保存します。

mock command の `webServer.command` は `scripts/start-test-server.sh` を実行します。
この script は通常 `pnpm run build:local-mock` で frontend を production build し、その後
`pnpm tsx scripts/dev/static-hono-server.ts` で local Hono API と static frontend を
直接起動します。server 起動は `pnpm start` を経由しないため、developer の
`.env.local` を dotenv で server process に読み込みません。

`SKIP_VITE_BUILD=1` かつ `dist/index.html` が存在する場合は既存 build を再利用します。
ファイルがなければ build します。再利用時に script が確認するのはファイルの存在だけなので、
実行者が今回の source と `VITE_RUNTIME_PROFILE=static-mock-e2e` に対応する build であることを
確認してください。

script は server と browser の selector をそれぞれ
`RUNTIME_PROFILE=static-mock-e2e` / `VITE_RUNTIME_PROFILE=static-mock-e2e` に固定します。
この一つの profile から次の構成が fail-closed に決まります。

- server: file-backed session store、mock proof、sync finalization、local artifact reader
- browser: same-origin API、Turnstile bypass eligible、各 action の Turnstile 不要

個別の mock / store / Turnstile flag は使いません。reusable/deployable な
`pnpm build:ci` artifact は `target-aws-async` browser profile を選択し、
test-only の Turnstile bypass を含みません。

`scripts/start-test-server.sh` はさらに以下を固定または補完してから起動します。

- `NODE_ENV=production` を固定
- `EXPECTED_IMAGE_ID_VARIANT=x86_64` を必要時に補完
- `VERIFIER_PUBLIC_BASE_URL` は server の `PORT` に合わせて既定化（Playwright は `http://localhost:3100` を指定）
- `VITE_STH_SOURCES=/api/sessions/:sessionId/bulletin/sth,/api/sessions/:sessionId/bulletin/sth?auditorId=b`
  を既定化
- `LOG_LEVEL=error` を必要時に補完
- `RUNTIME_DEPLOYMENT_ENV=develop` を必要時に補完
- `SESSION_CAPABILITY_SECRET` が未設定なら `scripts/tests/.env.test.defaults` の test-only 値を補完
- default store の `.tmp/mock-sessions/` を掃除

`FileMockSessionStore` は全 record family を一つの `sessions.json` snapshot に保存し、
snapshot の signature が変わったときに long-lived reader の state を更新します。
store 固有の環境 control は `FILE_MOCK_STORE_DIR` のみで、未設定時の保存先は
`.tmp/mock-sessions/` です。override を使う場合、起動時の default store cleanup は
その custom directory には適用されません。

## 検証戦略

`voting-flow.spec.ts` は mock Bot 投票のランダム性に依存しないよう、UI 表示の合計整合性を確認します。

```typescript
const tallySum = tallyCounts.reduce((sum, count) => sum + count, 0);
expect(tallySum).toBe(totalVotes);
```

このため、mock 環境では選択肢ごとの固定分布ではなく、総数と verify check の整合性を見ます。

さらに smoke では verify 画面の `data-status` を読み、S0 / S2 ともに tally・missing indices・manifest・close statement・STH・receipt・step status の主要 check を確認します。S2 では特に `counted_tally_consistent=failed` と `stark_receipt_verify=success`／`stark_verification=success` を確認し、mock receipt の検証状態が成功でも claimed tally の不整合を検出することを確かめます。S0 の summary は `demo_only` です。これらの mock status を production STARK proof の正しさの証拠として扱いません。

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
<span data-testid="tally-value-A">14</span>
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

## 出力物

- HTML report: `playwright-report/`
- JSON report: `test-results/results.json`
- manual failure screenshot (`voting-flow.spec.ts`): `test-results/failure-*.png`
- trace / video / Playwright attachments: `test-results/` 配下
