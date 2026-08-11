# API リファレンス

この部では、ブラウザクライアント、CLI、第三者検証で使う公開 API を、現行実装に基づいて説明します。

<a id="含まれるページ"></a>

## この部の章

- [エンドポイント一覧](endpoints.md): active browser / CLI API と owner-scoped tooling API のリクエスト/レスポンス仕様
- [セッションライフサイクル](session-lifecycle.md): クライアントとサーバーのセッション管理実装

## 想定読者と前提

- 想定読者: ブラウザクライアントや第三者検証ツールから API を呼び出す実装者
- 前提: HTTP とセッションヘッダーの基本、および本書 [全体像](../overview.md) のフローを把握していること

<a id="本章で扱わないもの"></a>

## この部で扱わないもの

通常の browser / CLI contract は active route と capability 保護 API に限ります。
以下はこの部では扱いません。

- retired な debug / private inspection route（`GET /api/debug/enable`、`GET /api/botdata/:id`）の詳細
- 置換済みの flat route（`POST /api/finalize/callback`、`GET /api/zkvm-input-hash`）の詳細
- internal/operator-only callback（`POST /api/internal/sessions/:sessionId/finalizations/:finalizationId/callback`）の protocol details
- input commitment の private-data variant。active な `GET /api/sessions/:sessionId/finalizations/current/input-commitment` は hash-only で、`includeData` query を受理しません（詳細は[エンドポイント一覧](endpoints.md)）
- raw S3 URL / presigned URL を通常の browser / CLI contract として扱う取得経路。bundle/report の取得契約は[エンドポイント一覧](endpoints.md)に委譲します
- レート制限、Turnstile、capability TTL などの環境変数チューニング
- API Gateway、Hono、Lambda 側の認可とルーティング実装

## 関連する章

- [検証パイプライン](../verification/index.md): `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification` が返す検証ペイロードの内訳
- [利用フロー](../usage-flow.md): browser / CLI flow と bundle/report 取得経路
- [第三者検証ガイド](../reproducibility/index.md): `bundle.zip` の取得とローカル監査
- [用語集](../appendix/glossary.md): capability トークンと session-scoped API の用語定義

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/routes/inventory.test.ts, apps/api/src/server/api/routes/hono.ts -->
