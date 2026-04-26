# Hono API 分離プラン（Amplify Gen2 + API Gateway）

**ステータス**: ✅ 実装完了（2026-01-02）

作成日: 2026-01-01

> Public note: deployment-specific origins, API Gateway URLs, and account-scoped
> values are intentionally represented as placeholders in this document. Keep
> concrete operational evidence in private docs or archive notes.

## 目的

- Next.js UI/SSR と API 層を分離し、Hono を Lambda + API Gateway に載せる。
- 既存の `src/server/api` を再利用し、最小差分で段階移行する。

## 既存前提

- API ハンドラは `src/server/api/handlers/*` に集約済み。
- ルート定義は `src/server/api/routes/registry.ts` が唯一の登録元。
- Hono 側の統合は `src/server/api/routes/hono.ts` が完了。
- Amplify の `hono-api` Lambda と API Gateway (HttpApi) は CDK で構築済み。
- `/api/verification/bundles/*` は **ローカルFS fallback** があるため、Lambda 分離時は **S3 経由を前提**にする。

## 移行方針（最小差分）

- **Hono 専用ディレクトリ/`package.json` は作らない**。
- Amplify の `functions` に Hono Lambda の入口だけ追加する。
- ルート除外は「登録段階」で制御（`diag` など）。

## ルート除外ポリシー

- 移行対象外:
- 条件付き:
  - `/api/verification/bundles/*`
    - Lambda では **S3 redirect のみ**を許可
    - `USE_S3=true` を前提（ローカルFSは不可）
- 参考: `/api/diag/env` と `/api/test-data/*` は本番露出回避のため削除済み

## 実装ステップ（Big-Bang 前提）

### Phase 1: Hono Lambda 入口を追加（実装済み）

- `amplify/functions/hono-api/resource.ts`
  - `defineFunction({ runtime: 22, timeoutSeconds: 60, memoryMB: 1024 })`
- `amplify/functions/hono-api/handler.ts`
  - `createHonoApp({ basePath: '/api', mode: 'lambda' })`
  - `hono/aws-lambda` の `handle(app)` で Lambda 化（配信サイズが大きい場合は `streamHandle` を検討）

```ts
// amplify/functions/hono-api/handler.ts
import { handle } from 'hono/aws-lambda';
import { createHonoApp } from '../../../src/server/api/routes/hono.js';

const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

export const handler = handle(app);
```

### Phase 2: API Gateway を Amplify で作成（実装済み, CDK）

- `amplify/backend.ts` に CDK で `HttpApi` を追加
- `HttpLambdaIntegration` で `hono-api` Lambda に接続
- `backend.addOutput()` で `HonoApiUrl` を出力（Amplify Outputs に載せる）
- 別ドメイン運用の場合は `corsPreflight` を設定（許可オリジン・ヘッダを明示）
- 許可オリジンは環境変数 `HONO_CORS_ALLOW_ORIGINS`（カンマ区切り）で管理
  - **必須**: 未設定だと CDK で例外になるため、値を必ず設定する
  - 設定例: `<AMPLIFY_APP_ORIGIN>,http://localhost:3000,<PUBLIC_APP_ORIGIN>`

例: `HONO_CORS_ALLOW_ORIGINS`（UI から API を直叩きする場合）

- `<AMPLIFY_APP_ORIGIN>,http://localhost:3000`（開発）
- `<PUBLIC_APP_ORIGIN>`（main/prod）

許可ヘッダ（少なくとも）:

- `Content-Type`
- `X-Session-ID`

### Phase 3: ルート定義に「lambda モード」を追加（実装済み）

- **案A（kind追加）**: `ApiRouteKind` に `diagnostic`（必要なら `internal`）を追加
- **案B（フラグ追加）**: `excludeFromLambda?: boolean` を `ApiRouteDefinition` に追加
- `ApiRouteMode` に `lambda` を追加
- `getApiRouteDefinitions('lambda')` は `diagnostic` または `excludeFromLambda` を除外

### Phase 4: 環境変数の整備（Lambda）

最低限の追加（例）:

- `USE_AMPLIFY_DATA=true`
- `AMPLIFY_DATA_ENDPOINT`
- `AMPLIFY_DATA_REGION`
- `AMPLIFY_DATA_TTL_SECONDS`
- `AMPLIFY_DATA_VERIFICATION_TTL_SECONDS`
- `COGNITO_IDENTITY_POOL_ID`
- `HONO_CORS_ALLOW_ORIGINS`（CORS 許可オリジンのカンマ区切り）
- `S3_PROOF_BUCKET`
- `S3_PROOF_PREFIX`
- `USE_S3=true`
- `PROVER_WORK_QUEUE_URL`
- `PROVER_STATE_MACHINE_ARN`（必要なら）
- `FINALIZE_ASYNC_MODE`
- `PROVER_STEP_FUNCTIONS_ENABLED`
- `TURNSTILE_SECRET_KEY`
- `TURNSTILE_BYPASS`
- `VERIFIER_PUBLIC_BASE_URL`（API Gateway の URL を注入）
- `FINALIZE_CALLBACK_SECRET`（通常不要。`/api/finalize/callback` を Hono/Next で直接運用する場合のみ）
- `FINALIZE_CALLBACK_MAX_SKEW_MS`（HMAC 許容スキュー）
- `EXPECTED_IMAGE_ID`（任意: 未設定でもフォールバックあり）
- `VERIFIER_SERVICE_RUNNER_FUNCTION_NAME`
- `ENV_NAME`（任意: sandbox/develop/main など）
- `AWS_REGION`（任意: Lambda が自動設定）

### Phase 5: IAM 付与（実装済み）

Hono Lambda に必要な権限（最小セット）:

- `appsync:GraphQL`
- `s3:GetObject`, `s3:ListBucket`
- `sqs:SendMessage`
- `states:DescribeExecution`, `states:StopExecution`
- `cognito-identity:GetId`, `cognito-identity:GetCredentialsForIdentity`
- `lambda:InvokeFunction`（verifier-service-runner 呼び出し）

### Phase 6: クライアント切替（Big-Bang）

- `NEXT_PUBLIC_API_BASE_URL` を導入
- Fetch を `getApiBaseUrl()` 経由に統一（`/api` 既定）
- `NEXT_PUBLIC_API_BASE_URL` を **Hono HttpApi endpoint** に設定し、全 API を一気に切替

## テスト戦略

- `createHonoApp()` の `app.request()` テストを継続
- 既存の Next Route Handler テストは温存
- 切替後の検証は E2E (Playwright) で確認

## ロールバック方針

- UI 側の `NEXT_PUBLIC_API_BASE_URL` を空に戻すだけで復帰可能
- Next の `/api/*` ルートは削除せず残す

## Big-Bang 手順（運用）

1. **環境変数の確認**（Lambda/Hono）  
   必須: `HONO_CORS_ALLOW_ORIGINS`, `COGNITO_IDENTITY_POOL_ID`, `USE_AMPLIFY_DATA`, `AMPLIFY_DATA_*`,
   `USE_S3`, `S3_PROOF_*`, `PROVER_WORK_QUEUE_URL`, `FINALIZE_ASYNC_MODE`,
   `PROVER_STEP_FUNCTIONS_ENABLED`, `TURNSTILE_*`,
   `FINALIZE_CALLBACK_MAX_SKEW_MS`, `VERIFIER_PUBLIC_BASE_URL`（必要なら）, `ENV_NAME`
2. **Hono API が応答することを確認**  
   `HonoApiUrl` の `/api/progress` 等で疎通確認
3. **UI の切替**  
   `NEXT_PUBLIC_API_BASE_URL` を `HonoApiUrl` に設定
4. **エンドツーエンド確認**  
   `POST /session` → `POST /vote` → `POST /finalize` → `GET /verify`
5. **問題があればロールバック**
   `NEXT_PUBLIC_API_BASE_URL` を空に戻す

## 実施結果（2026-01-02）

- ✅ Phase 1-5: すべて実装完了
- ✅ Phase 6 (Big-Bang): develop ブランチで切替完了
  - `NEXT_PUBLIC_API_BASE_URL` を `<HONO_API_ORIGIN>` に設定
  - Voting フロー（session → vote → finalize → verify）が正常動作
  - CloudWatch Logs で Hono Lambda の動作確認済み
- ✅ CORS 問題解決: `hono/cors` ミドルウェア追加
- ✅ 環境変数参照問題解決: 静的 `process.env.NEXT_PUBLIC_API_BASE_URL` に修正

### 学んだ教訓

1. **Next.js のビルド時環境変数置換**: `process.env[dynamicKey]` は置換されない。`process.env.NEXT_PUBLIC_*` の静的アクセスが必須。
2. **CORS ミドルウェア**: `app.options('*', ...)` だけでは不十分。`hono/cors` を使用すること。
3. **Amplify Gen2 + CDK**: `HttpLambdaIntegration` と `backend.addOutput()` パターンが公式推奨。

## カスタムドメインと basePath / VERIFIER_PUBLIC_BASE_URL

| パターン        | UI                                      | API (Hono)                       | basePath | VERIFIER_PUBLIC_BASE_URL |
| --------------- | --------------------------------------- | -------------------------------- | -------- | ------------------------ |
| A: サブドメイン | `<PUBLIC_APP_ORIGIN>`                   | `<PUBLIC_API_ORIGIN>`            | /api(\*) | `<PUBLIC_API_ORIGIN>`    |
| B: パスベース   | `<PUBLIC_APP_ORIGIN>/*`                 | `<PUBLIC_APP_ORIGIN>/api/*`      | /api     | `<PUBLIC_APP_ORIGIN>`    |
| C: デフォルト   | `<AMPLIFY_APP_ORIGIN>` / local frontend | `<API_GATEWAY_DEFAULT_ENDPOINT>` | /api     | `<HONO_API_ORIGIN>`      |

(\*) `basePath: '/'` にしたい場合は、`/api` 前提の呼び出し・テストを一括調整する必要がある。

推奨: 初期は C（デフォルト）で進め、カスタムドメインは後から追加可能。`basePath: '/api'` を維持すれば移行が楽。

## /api/test-data/\* の扱い

- 本番露出リスクを避けるため、エンドポイントは削除済み。

## オープン事項

- API Gateway のカスタムドメインを使うか
- `VERIFIER_PUBLIC_BASE_URL` の適用先（Hono/Next の両方）
- WAF/レート制限を API Gateway 側で入れるか
