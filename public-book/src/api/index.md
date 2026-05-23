# API リファレンス

この章では、公開ドキュメントとして扱うべき API（ブラウザクライアントと第三者検証で利用するエンドポイント）を、現行実装ベースで説明します。

## この部に含まれる章

- [エンドポイント一覧](endpoints.md) — 外部クライアント向け API のリクエスト/レスポンス仕様
- [セッションライフサイクル](session-lifecycle.md) — クライアントとサーバーのセッション管理実装

## 想定読者と前提

- 想定読者: ブラウザクライアントや第三者検証ツールから API を呼び出す実装者
- 前提: HTTP / セッションヘッダーの基本と、本書 [全体像](../overview.md) のフローを把握していること

## 本章で扱わないもの

- 内部運用/デバッグ向け API（`/api/debug/*`、`/api/finalize/callback`）の詳細
- レート制限・Turnstile・capability TTL などの環境変数チューニング
- Amplify / Hono / Lambda 側の認可・ルーティング実装

## 関連する章

- [検証パイプライン](../verification/index.md) — `/api/verify` が返す検証ペイロードの内訳
- [第三者検証ガイド](../reproducibility/index.md) — `bundle.zip` の取得とローカル監査
- [用語集](../appendix/glossary.md) — capability トークン・session-scoped API の用語定義

<!-- source: src/server/api/ -->
