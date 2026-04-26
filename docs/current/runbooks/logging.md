# Logging Runbook

> **目的**: 本番環境（`NODE_ENV=production` 固定）でも安全に追加ログを出したいときの運用手順。
> **前提**: サーバーログは `logger` 経由に統一。`console.log` は原則使用しない。

## 方針（短く）

- 追加ログは **署名付きトークン**で一時的に有効化する
- 期限付き（TTL）で自動失効させる
- ログは **PII/機密情報を出さない**（マスク/削除）
- ログ量は必要最小限。濫用防止（監査ログ/運用記録）

## 仕組み概要

- 署名トークンを検証できた場合のみ、**リクエスト単位**で log level を `debug` に上げる
- 有効化は `/?stark_ballot_debug=<token>` でトリガー → `/api/debug/enable` が `HttpOnly` Cookie をセット
- API 直叩き時は `X-Debug-Log: <token>` ヘッダでも有効
- **注意**: `logger.debug` 以外の `console.log` はこの仕組みで制御できない
- 互換のため `?debug=<token>` も受け付けるが、誤衝突を避けるため **トークン形式のみ**対応

## 有効化手順（運用）

### 1) 環境変数を設定

```text
DEBUG_LOG_SECRET=<32文字以上のランダム文字列>
# optional
DEBUG_LOG_MAX_TTL_SECONDS=900
DEBUG_LOG_COOKIE_SECURE=0
```

- `DEBUG_LOG_SECRET` が **未設定 or 短すぎる**場合は機能自体が無効
- TTL は 15分（900秒）がデフォルト
- `DEBUG_LOG_COOKIE_SECURE=1` で http でも Secure Cookie 強制可

### 2) トークンを生成

```text
pnpm tsx -e "import { createDebugLogToken } from './src/lib/security/debugLogToken'; const now=Math.floor(Date.now()/1000); console.log(createDebugLogToken({ level: 'debug', expiresAt: now+900 }, process.env.DEBUG_LOG_SECRET!));"
```

### 3) ログを一時的に有効化

- ブラウザでトップページにアクセス:

```text
/?stark_ballot_debug=<token>
```

- 以降は `stark_ballot_debug` Cookie が有効な間、**サーバーログが debug になる**

### 4) 明示的に無効化

```text
/?stark_ballot_debug=off
```

## API だけで有効化したい場合

- ヘッダで直接トークン指定:

```text
X-Debug-Log: <token>
```

- CORS を跨ぐ場合は `X-Debug-Log` が許可済み（Hono CORS）

## 失効・ローテーション

- TTL 超過 → 自動失効
- `DEBUG_LOG_SECRET` を更新すると **全トークン即失効**

## PII/機密情報の扱い

- 可能な限り **ID をハッシュ化/短縮**して出す
- 生の個人情報・秘密鍵・トークン・Cookie 値は出さない
- 「一時デバッグ」の範囲を超えないこと

## トラブルシューティング

- **ログが増えない**
  - `DEBUG_LOG_SECRET` が設定されているか
  - `logger.debug(...)` を使っているか（`console.log` は効かない）
  - トークンが期限切れ/署名不正ではないか

- **Cookie が付与されない**
  - `/api/debug/enable` が 302 を返しているか
  - `HttpOnly` のため JS では見えない（ブラウザの DevTools で確認）

- **API だけで有効化したい**
  - `X-Debug-Log` ヘッダを使う

## 実装参照

- トークン生成/検証: `src/lib/security/debugLogToken.ts`
- ログレベル制御: `src/lib/utils/logger.ts`
- 有効化ハンドラ: `src/server/api/handlers/debugLog.ts`
- プロキシ経由トリガー: `src/proxy.ts`
- Cookie/ヘッダ処理: `src/server/http/debugLog.ts`
