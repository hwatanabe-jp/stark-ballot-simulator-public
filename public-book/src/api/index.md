# API リファレンス

一票の操作を API でたどると、まずセッションを作り、そのセッションに投票し、集計を作成して検証します。ダウンロードする証拠も、どのセッションのどの集計に属するかを URL で指定します。

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
