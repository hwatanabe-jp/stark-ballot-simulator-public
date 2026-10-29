# API リファレンス

API は、セッション作成、投票、集計、検証、証拠の取得を提供します。セッションと集計の識別子は URL のパスで指定します。ダウンロードする証拠も、同じ識別子で集計に対応付けます。

```text
/api/sessions
  /:sessionId/votes
  /:sessionId/finalizations
    /current
    /:finalizationId/verification
    /:finalizationId/artifacts/bundle
    /:finalizationId/artifacts/report
```

セッション作成時に受け取る capability token を、それ以降の要求では `X-Session-Capability` ヘッダーに付けます。URL の識別子だけではデータを取得できません。集計 ID も現在のセッションと一致するかをサーバーが確認します。

実際の要求・応答とエラーは [エンドポイント一覧](endpoints.md) にまとめています。再読み込みや別タブで操作したときの状態の扱いは [セッションの保存と継続](session-lifecycle.md) で説明します。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/routes/inventory.test.ts, apps/api/src/server/api/routes/hono.ts -->
