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
UI の最終判定には、session-scoped な自票 proof、bitmap proof、設定時の third-party STH evidence、サーバー側の STARK receipt verification 結果も関わります。

## public bundle の default-deny manifest

同期生成の `bundle.zip` は次の member に限定されます。async bundle は共通の必須 5 member
だけを含みます。

| ファイル                 | 扱い | 役割                                                            |
| ------------------------ | ---- | --------------------------------------------------------------- |
| `public-input.json`      | 必須 | 秘密値を除いた zkVM 入力側の公開監査レコード                    |
| `election-manifest.json` | 必須 | 選挙設定と `electionConfigHash` を照合するための公開レコード    |
| `close-statement.json`   | 必須 | 集計締切時点の `logId` / `treeSize` / `bulletinRoot` 境界       |
| `receipt.json`           | 必須 | production 検証で実証明として検証する STARK receipt payload     |
| `journal.json`           | 必須 | tally、root、count、commitment などを含む zkVM の公開出力       |
| `metadata.json`          | 必須 | sync bundle の作成時刻、session ID、method version など         |
| `sth.json`               | 任意 | STH snapshot を bundle に保存する場合の公開可能 evidence        |
| `consistency-proof.json` | 任意 | CT-style append-only consistency proof を保存する場合の公開証拠 |

`receipt.json` が含まれていても、それだけで production STARK proof として成功扱いにはなりません。
開発モードの receipt は production STARK proof ではなく、production 検証では fail-closed に扱います。

新しい artifact は、生成された時点では private です。公開可能かどうかを各 builder
や配信 handler が個別に推測せず、canonical manifest に明示的に追加され、sync/async
member set と completed-archive admission の review を通過した場合にだけ
`bundle.zip` へ入れられます。この default-private / allowlist-driven 方針により、
新しい内部 artifact の追加が意図しない公開へ直結することを防ぎます。

manifest にない member は private が既定です。required member の欠落、private/unknown member、
duplicate/case conflict、traversal・absolute・非 canonical path を含む completed ZIP は
publication/delivery より前に拒否されます。

## bundle.zip に入れないファイル

次のファイルは `bundle.zip` のメンバーではありません。

| ファイル               | 理由                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `input.json`           | 投票選択や乱数を含み得る zkVM witness 付き private input       |
| `verification.json`    | 検証サービスの protected report artifact                       |
| `included-bitmap.json` | counted された index を説明する private bitmap artifact        |
| `seen-bitmap.json`     | prover に提示された index を説明する private bitmap artifact   |
| `failure-marker.json`  | async prover の bounded category だけを持つ private diagnostic |

`input.json`、`verification.json`、`included-bitmap.json`、`seen-bitmap.json` の 4 つは、モードに依存しない保護対象です。
`verification.json` は必要な場合に `bundle.zip` とは別の report endpoint から取得します。
`failure-marker.json` は非同期モードのみで生成され得る private diagnostic で、report endpoint からも配布しません。ライフサイクル契約の詳細は [非同期プローバー](../aws/async-prover.md) を参照してください。

## bundle と report の取得経路

通常のブラウザと CLI の contract は、次の capability 保護 API です。

| エンドポイント                                                                | 返すもの                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle` | public `bundle.zip`                           |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report` | protected `verification.json` report artifact |

どちらも session capability によって保護されます。
`finalizationId` は、その session の現在の succeeded finalization record が持つ
`finalizationId` と一致している必要があります。

S3-backed 実行でも、ブラウザと CLI は raw S3 URL や presigned URL を通常契約として使いません。
API handler が権限と finalization scope を確認したうえで、ローカル保存または S3 から artifact を読み出して返します。
大きい S3 bundle は、同じ API 経由の range response で配信されます。

## sync mode と async mode の差分

公開境界(何を入れないか)は sync mode と async mode で同じです。
モードごとの実際のメンバー構成、生成環境、生成フローの差分は [バンドル構造](bundle-structure.md) を参照してください。

## 実装上の照合点

この境界を確認するときは、次の実装を合わせて参照します。

- mode-aware manifest and archive admission:
  `packages/verification/src/verification/public-bundle-manifest.{json,ts}`
- sync/async builders: `packages/verification/src/verification/verification-bundle.ts`,
  `infra/docker/entrypoint.sh`
- async prover failure marker: `infra/docker/prover-failure-marker-contract.json`, `packages/aws-adapters/src/finalize/async-prover-artifacts.ts`
- authenticated bundle/report delivery: `apps/api/src/server/api/handlers/verificationBundles.ts`
- 現行 verification flow notes: `docs/verification/README.md`

詳細なファイル構造とローカル監査手順は、[バンドル構造](bundle-structure.md) と [第三者検証ガイド](../reproducibility/index.md) を参照してください。

<!-- source: packages/verification/src/verification/public-bundle-manifest.json, packages/verification/src/verification/public-bundle-manifest.ts, packages/verification/src/verification/verification-bundle.ts, packages/aws-adapters/src/finalize/async-prover-artifacts.ts, infra/docker/entrypoint.sh, infra/docker/prover-failure-marker-contract.json, apps/api/src/server/api/handlers/verificationBundles.ts, docs/verification/README.md -->
