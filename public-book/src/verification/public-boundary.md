# 公開境界

検証アーティファクトは、`bundle.zip` に入れる公開可能データと、保護対象として残すデータに分かれます。

ここでいう `public` は、「秘密を含まず、第三者検証に使える公開可能データ」という機密性の分類です。
「無認証で誰でも取得できること」は意味しません。
通常のブラウザと CLI では、`bundle.zip` も検証レポートも session capability で保護された API から取得します。

## 境界の原則

`bundle.zip` は、公開可能アーティファクトだけを含む監査用アーカイブです。
zkVM の witness、投票内容を復元し得る入力、個票状態を細かく説明する private bitmap、検証サービスの protected report artifact は含めません。

この境界は利便性より優先します。
`bundle.zip` 単体で `/verify` 画面の最終判定を完全再現できない場合でも、private artifact を公開アーカイブへ混ぜません。
UI の最終判定には、session-scoped な本人票 proof、bitmap proof、設定時の third-party STH evidence、サーバー側の STARK receipt verification 結果も関わります。

## public bundle の許可リスト

同期生成の `bundle.zip` で許可されるファイルは、次の許可リストに限定されます。

| ファイル                 | 扱い | 役割                                                            |
| ------------------------ | ---- | --------------------------------------------------------------- |
| `public-input.json`      | 必須 | 秘密値を除いた zkVM 入力側の公開監査レコード                    |
| `election-manifest.json` | 必須 | 選挙設定と `electionConfigHash` を照合するための公開レコード    |
| `close-statement.json`   | 必須 | 集計締切時点の `logId` / `treeSize` / `bulletinRoot` 境界       |
| `receipt.json`           | 必須 | production 検証で実証明として検証する STARK receipt payload     |
| `journal.json`           | 必須 | tally、root、count、commitment などを含む zkVM の公開出力       |
| `metadata.json`          | 任意 | sync bundle の作成時刻、session ID、method version など         |
| `sth.json`               | 任意 | STH snapshot を bundle に保存する場合の公開可能 evidence        |
| `consistency-proof.json` | 任意 | CT-style append-only consistency proof を保存する場合の公開証拠 |

`receipt.json` が含まれていても、それだけで production STARK proof として成功扱いにはなりません。
開発モードの receipt は production STARK proof ではなく、production 検証では fail-closed に扱います。

## bundle.zip に入れないファイル

次のファイルは `bundle.zip` のメンバーではありません。

| ファイル               | 理由                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `input.json`           | 投票選択や乱数を含み得る zkVM witness 付き private input     |
| `verification.json`    | 検証サービスの protected report artifact                     |
| `included-bitmap.json` | counted された index を説明する private bitmap artifact      |
| `seen-bitmap.json`     | prover に提示された index を説明する private bitmap artifact |

`verification.json` は public bundle member ではありません。
サーバー側の STARK receipt verification 結果として保存される protected report artifact であり、必要な場合は `bundle.zip` とは別の report endpoint から取得します。

## bundle と report の取得経路

通常のブラウザと CLI の contract は、次の capability 保護 API です。

| エンドポイント                                                 | 返すもの                                      |
| -------------------------------------------------------------- | --------------------------------------------- |
| `GET /api/verification/bundles/:sessionId/:executionId`        | public `bundle.zip`                           |
| `GET /api/verification/bundles/:sessionId/:executionId/report` | protected `verification.json` report artifact |

どちらも session capability によって保護されます。
`executionId` は、その session に記録された現在の `verificationExecutionId` と一致している必要があります。

S3-backed 実行でも、ブラウザと CLI は raw S3 URL や presigned URL を通常契約として使いません。
API handler が権限と execution scope を確認したうえで、ローカル保存または S3 から artifact を読み出して返します。
大きい S3 bundle は、同じ API 経由の range response で配信されます。

## sync mode と async mode の差分

公開境界は sync mode と async mode で同じですが、`bundle.zip` の中身には実装上の差があります。

| モード | public `bundle.zip` に入るもの                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------- |
| sync   | 通常は必須 5 ファイルと `metadata.json` を含み、任意証拠も許可される allowlist 全体が対象             |
| async  | `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`, `journal.json` |

async mode では ECS Fargate prover が public audit artifact を生成し、`bundle.zip` を S3 に保存します。
`included-bitmap.json` と `seen-bitmap.json` が生成される場合でも、bundle member ではなく隣接する private artifact として扱います。
`verification.json` は finalize 時点の public bundle には入らず、後続の verifier run が保存した場合に protected report として参照されます。

sync mode では TypeScript 側の allowlist に基づいて archive を作成します。
`input.json`、`included-bitmap.json`、`seen-bitmap.json`、`verification.json` が保存される場合でも、`bundle.zip` には含めません。

## 実装上の照合点

この境界を確認するときは、次の実装を合わせて参照します。

- sync bundle allowlist: `packages/verification/src/verification/verification-bundle.ts`
- async bundle creation: `infra/docker/entrypoint.sh`
- authenticated bundle/report delivery: `apps/api/src/server/api/handlers/verificationBundles.ts`
- 現行 verification flow notes: `docs/verification/README.md`

詳細なファイル構造とローカル監査手順は、[バンドル構造](bundle-structure.md) と [第三者検証ガイド](../reproducibility/index.md) を参照してください。

<!-- source: packages/verification/src/verification/verification-bundle.ts, infra/docker/entrypoint.sh, apps/api/src/server/api/handlers/verificationBundles.ts, docs/verification/README.md -->
