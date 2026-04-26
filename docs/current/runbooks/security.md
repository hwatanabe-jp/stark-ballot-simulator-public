# Security Runbook

## Turnstile Operations

1. **Widget provisioning**
   - Cloudflare Dashboard → Turnstile → _Create_
   - Type: Managed, Domain: `stark-ballot.example.com`
   - Copy Site key → `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
   - Copy Secret key → `TURNSTILE_SECRET_KEY`（Amplify Hosting: App settings → Secrets and variables → Secrets）
2. **Environments**
   - Development / CI: set `NEXT_PUBLIC_TURNSTILE_BYPASS=1` and `TURNSTILE_BYPASS=1`
   - Production demo: set both bypass flags to `0` and verify widget renders
   - Session create hardening (optional): set `SESSION_CREATE_TURNSTILE_REQUIRED=1` (+ `NEXT_PUBLIC_SESSION_CREATE_TURNSTILE_REQUIRED=1` for UI gating)
3. **Failure response**
   - API returns `CAPTCHA_FAILED`
   - Frontend surfaces `errors.captchaFailed` and re-renders widget

## Challenge Page (Cloudflare)

> **Status (2026-01-04)**: **有効化済み**。`<PUBLIC_APP_DOMAIN>` の _Proxied_ 配信で `/vote`・`/aggregate`・`/verify` に **Managed Challenge** を適用。Challenge Page は **プロキシ有効時のみ**適用されるため、DNS Only に戻すと無効になる。

1. **DNS**: ensure domain uses Cloudflare NS, set application records to _Proxied_
2. **Activation**: Security → WAF → Custom Rules → Managed Challenge
3. **Managed Challenge rule (current)**:
   - Rule: Managed Challenge
   - Conditions:
     - URI Path equals `/vote`
     - URI Path equals `/aggregate`
     - URI Path equals `/verify`
   - Turnstile pre-clearance: **Managed**
4. **Bypass (optional)**:
   - CI は本番環境にアクセスしないため、通常はバイパス設定不要。
   - 手動検証や外部自動化で必要になった場合のみ、Security Rules で特定パスを “Essentially Off” に設定する。
   - Optional: Workers token for future automation

## API Gateway 直叩き防止

> **Status (2026-01-04)**: 本番で有効化済み（`<PUBLIC_API_DOMAIN>` + `disableExecuteApiEndpoint=true`）。API ドメインは DNS only 運用。

### 概要

WAF を使わずに API Gateway への直叩きを防止し、Cloudflare 経由のみでアクセス可能にする。

### 実装手順（再設定時のチェックリスト）

1. **ACM 証明書発行**: `<PUBLIC_API_DOMAIN>` 用のリージョナル証明書（ap-northeast-1）
2. **API Gateway カスタムドメイン作成**: カスタムドメイン + API Mapping
3. **Cloudflare CNAME**: カスタムドメインを CNAME で設定（現状は DNS only。Proxied を使う場合はプランに応じて切替）
4. **環境変数更新**: `NEXT_PUBLIC_API_BASE_URL` を新ドメインに変更（Amplify 再ビルド必須）
5. **execute-api 無効化**: `disableExecuteApiEndpoint: true` で直叩き URL を無効化

> **注意**: API 側の L7 防御を Cloudflare に依存する場合は **Proxied 配信が必須**。DNS Only では Cloudflare の L7 防御は効かない。

### 検証方法

```bash
# カスタムドメイン経由（200 を期待）
curl -I https://<PUBLIC_API_DOMAIN>/api/session

# 直叩き（403 を期待、または接続不可）
curl -I https://<id>.execute-api.ap-northeast-1.amazonaws.com/api/session
```

### ロールバック

1. `NEXT_PUBLIC_API_BASE_URL` を元の execute-api URL に戻す
2. Cloudflare の CNAME を DNS Only に変更、または削除
3. `disableExecuteApiEndpoint` を false に戻す（必要に応じて）

## Rate Limiting

- `/api/session`: dedicated per-IP limiter (`SESSION_CREATE_RATE_LIMIT` / `SESSION_CREATE_RATE_LIMIT_WINDOW_MS` / `SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS`)
- `/api/vote`: DynamoDB-backed sliding window (10 requests/min per IP). Adjust via `VOTE_RATE_LIMIT` and `VOTE_RATE_LIMIT_WINDOW_MS`
- `/api/finalize` / `/api/verification/run`: DynamoDB-backed per-IP (24h/50) + global quotas (hourly 100, daily 1000)
- Store selection: `RATE_LIMIT_STORE=memory|dynamo` (default: memory for tests/CI)
- Invalid-request attempts are capped at 2× the success limit (per-IP); global quotas still apply only to successful zkVM executions
- API Gateway (HTTP API) throttling: set `API_THROTTLE_BURST_LIMIT` and `API_THROTTLE_RATE_LIMIT` together to apply stage-level limits
- `MAX_SESSIONS` is enforced at runtime for `/api/session`; creates are rejected with `SESSION_LIMIT_EXCEEDED` when cap is reached
- Set `TRUSTED_PROXY` explicitly in production (`api-gateway` or `both`) so IP-based controls rely on trusted headers only
- Monitor `GLOBAL_LIMIT_EXCEEDED` responses in logs

## Monitoring & Alerts

- **CloudWatch Logs Insights**: create saved queries for `CAPTCHA_FAILED`, `GLOBAL_LIMIT_EXCEEDED`, and rate-limit responses (503 for GLOBAL_LIMIT_EXCEEDED, 429 for ZKVM_RATE_LIMIT_EXCEEDED)
- **Metrics**: publish counts of 403 (CAPTCHA) / 503 (GLOBAL_LIMIT_EXCEEDED) / 429 (ZKVM_RATE_LIMIT_EXCEEDED) to CloudWatch; alert if >100 events/hour or sustained growth >3× baseline
- **Challenge Page**: watch Cloudflare Security Analytics for spikes; adjust Security Level or enable JS challenges when anomalies occur
- **Auth / AppSync IAM 監視**: 週次レポートで AWS 認証・署名・権限エラーを確認します。具体的な監視クエリと運用メモは private operations notes 側で管理します。

## Testing Checklist

- [ ] `pnpm ci:verify` passes locally (`format:check` / lint / type-check / unit / axe E2E / mock E2E)
- [ ] `pnpm public-safety:scan` passes before public snapshot or publishable-boundary changes
- [ ] Manual E2E smoke with `TURNSTILE_BYPASS=0` (widget + Challenge Page enabled)
- [ ] CI は mock E2E のみで、本番ドメインにアクセスしないことを確認
- [ ] Security headers validated via securityheaders.com / Mozilla Observatory

## CSP & Security Headers

- CSP is generated per-request in `src/proxy.ts` (nonce + strict-dynamic)
- Other headers are defined in `next.config.ts` (HSTS 2 years, XFO=DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- Use `pnpm lint` + `pnpm test:e2e:mock` to confirm no blocked assets

## CI Workflow

- `pnpm ci:verify` (`format:check` → lint → type-check → unit → `test:e2e:axe` → `test:e2e:mock`)
- `pnpm public-safety:scan` runs separately in the public-safety workflow and public snapshot release flow
- Run locally before PRs; CI should execute on push

## Container Image Security

### ECR Managed Signing

AWS Signer を使用したコンテナイメージ署名:

- **署名プロファイル**: `stark_ballot_simulator_ecr_signing`
- **対象リポジトリ**:
  - `stark-ballot-simulator/zkvm-prover-develop` (develop環境アプリイメージ)
  - `stark-ballot-simulator/zkvm-prover-main` (main環境アプリイメージ)
  - `stark-ballot-simulator/risc0-toolchain` (共有ベースイメージ)
- **digest固定が必須**: 署名ステータスは image digest 単位で評価されるため、ECS/ Terraform の `ecs_image_uri` は必ず `...@sha256:...` を使う。`latest`、semver、commit SHA などの tag 指定は不可
- **ランタイム検証**: Step Functions `VerifyImageSignature` 状態で署名検証

署名確認例:

```bash
aws ecr describe-image-signing-status \
  --repository-name stark-ballot-simulator/zkvm-prover-develop \
  --image-id imageDigest=sha256:... \
  --query 'signingStatuses[0].status'
```

### Vulnerability Scanning

ECR Basic Scanning (`scanOnPush=true`) による脆弱性スキャン:

```bash
# スキャン結果確認 (環境別リポジトリ)
aws ecr describe-image-scan-findings \
  --repository-name stark-ballot-simulator/zkvm-prover-develop \
  --image-id imageTag=<TAG> \
  --query 'imageScanFindings.findingSeverityCounts'

# main環境の場合
aws ecr describe-image-scan-findings \
  --repository-name stark-ballot-simulator/zkvm-prover-main \
  --image-id imageTag=<TAG> \
  --query 'imageScanFindings.findingSeverityCounts'

# HIGH/CRITICAL の詳細 (ベースイメージ)
aws ecr describe-image-scan-findings \
  --repository-name stark-ballot-simulator/risc0-toolchain \
  --image-id imageDigest=sha256:... \
  --query 'imageScanFindings.findings[?severity==`HIGH` || severity==`CRITICAL`]'
```

### Known Vulnerabilities (2026-03-21)

**risc0-toolchain ベースイメージ** (`sha256:0e7bf6820f0b570aa4d72036ca81b2e2ebd29245456e08e8a36c014cc1b56379`):

> Build #2 (2026-03-21, RISC Zero v3.0.5). 脆弱性評価は `aws ecr describe-image-scan-findings` で確認。
> ビルド時依存のみ使用、ランタイムイメージには含まれない。

**zkvm-prover アプリイメージ**:

- develop: `sha256:78834ad854083564db3caf95b46da0fcd85ab722e2edbe8de3d743a8b0fb1849` (署名済み ✅)
- main: `sha256:1c2f8f91aa70c6f7eaf74e4d91e4266300e73d20b171a1cf0cd665432dd6dbbc` (署名済み ✅)

### Update Procedures

1. **ベースイメージ更新時**:

   ```bash
   # 1. CodeBuild で再ビルド
   aws codebuild start-build --project-name stark-ballot-simulator-risc0-toolchain-builder

   # 2. 新しいダイジェスト取得
   aws ecr describe-images --repository-name stark-ballot-simulator/risc0-toolchain \
     --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageDigest'

   # 3. 必要なら git 管理外の build arg を生成
   AWS_ACCOUNT_ID="$YOUR_AWS_ACCOUNT_ID" ./scripts/update-risc0-digest.sh --write-env .tmp/risc0-toolchain-image.env

   # 4. アプリイメージ再ビルド
   # 5. アプリイメージの署名ステータスが COMPLETE になった digest を .env.local の Terraform 値に反映
   # 6. pnpm terraform:tfvars:<env> で local tfvars を再生成
   ```

2. **脆弱性対応優先度 / ゲート**:
   - zkVM prover アプリイメージ: HIGH/CRITICAL は `buildspec.yml` のビルド失敗ゲート
   - risc0-toolchain ベースイメージ: HIGH/CRITICAL はビルドを失敗させず、利用前レビューとこの runbook の Known Vulnerabilities で追跡
   - CRITICAL: 即時対応
   - HIGH: 1週間以内に評価、パッチ適用検討
   - MEDIUM/LOW: 定期メンテナンス時に対応

## Incident Playbook

1. **High bot traffic**
   - Increase Challenge Page sensitivity (Security Level: High)
   - Reduce `VOTE_RATE_LIMIT`
2. **False positives**
   - Temporarily raise limits via env overrides
   - 自動化が必要になった場合は一時的な Security Rule 例外を作成して記録
3. **Turnstile outage**
   - Set bypass flags to `1` (`NEXT_PUBLIC_TURNSTILE_BYPASS`, `TURNSTILE_BYPASS`)
   - If `/api/session` is gated, temporarily set `SESSION_CREATE_TURNSTILE_REQUIRED=0`
   - Document downtime and revert once service recovered
