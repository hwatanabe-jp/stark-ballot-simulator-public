# API リファレンス

この章では、ブラウザクライアント、CLI、第三者検証で使う公開 API を、現行実装に基づいて説明します。

## 含まれるページ

- [エンドポイント一覧](endpoints.md): active browser / CLI API と owner-scoped tooling API のリクエスト/レスポンス仕様
- [セッションライフサイクル](session-lifecycle.md): クライアントとサーバーのセッション管理実装

## 想定読者と前提

- 想定読者: ブラウザクライアントや第三者検証ツールから API を呼び出す実装者
- 前提: HTTP とセッションヘッダーの基本、および本書 [全体像](../overview.md) のフローを把握していること

## 本章で扱わないもの

通常の browser / CLI contract は active route と capability 保護 API に限ります。
以下は本章では扱いません。

- retired、内部運用、デバッグ向け API（`/api/debug/enable`、`/api/finalize/callback`）の詳細
- retired private inspection route（`GET /api/botdata/:id`）や `GET /api/zkvm-input-hash?includeData=true` などの private-data variant（active な `GET /api/zkvm-input-hash` contract は hash-only。詳細は[エンドポイント一覧](endpoints.md)）
- raw S3 URL / presigned URL を通常の browser / CLI contract として扱う取得経路（bundle/report は capability 保護された API から取得し、秘密を含まない public `bundle.zip` と protected report artifact の `verification.json` は別物）
- レート制限、Turnstile、capability TTL などの環境変数チューニング
- API Gateway、Hono、Lambda 側の認可とルーティング実装

## 関連する章

- [検証パイプライン](../verification/index.md): `/api/verify` が返す検証ペイロードの内訳
- [利用フロー](../usage-flow.md): browser / CLI flow と bundle/report 取得経路
- [第三者検証ガイド](../reproducibility/index.md): `bundle.zip` の取得とローカル監査
- [用語集](../appendix/glossary.md): capability トークンと session-scoped API の用語定義

<!-- source: apps/api/src/server/api/ -->
