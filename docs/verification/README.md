# STARK Ballot Simulator 検証バンドル & 検証フロー（現行実装）

このドキュメントは **現行コードに基づく実装仕様** をまとめたものです。設計案や計画ではなく、
`apps/` / `packages/` / `infra/docker/` / `infra/terraform/` が示す挙動を唯一の真実とします。

## 実装の参照先

| 対象                            | 実装                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 検証ステップ/チェック生成       | `packages/verification/src/verification/build-verification-steps.ts`, `packages/verification/src/verification/build-verification-checks.ts` |
| チェック定義                    | `packages/verification/src/verification/verification-checks.ts`                                                                             |
| `/api/verify`                   | `apps/api/src/server/api/handlers/verify.ts`                                                                                                |
| `/api/verification/run`         | `apps/api/src/server/api/handlers/verificationRun.ts`                                                                                       |
| `/api/verification/observation` | `apps/api/src/server/api/handlers/verificationObservation.ts`                                                                               |
| bundle/report 配布              | `apps/api/src/server/api/handlers/verificationBundles.ts`                                                                                   |
| sync bundle 生成                | `packages/verification/src/verification/verification-bundle.ts`                                                                             |
| async bundle 生成               | `infra/docker/entrypoint.sh`                                                                                                                |
| bitmap proof                    | `apps/api/src/server/api/handlers/bitmapProof.ts`                                                                                           |
| STH                             | `apps/api/src/server/api/handlers/sth.ts`                                                                                                   |

## 用語

- **receipt**: zkVM 実行の receipt artifact（`Receipt::verify(expectedImageId)` 対象）。`RISC0_DEV_MODE=1` の fake receipt は開発用 artifact であり、production STARK proof evidence ではない。Production STARK proof evidence として扱えるのは、dev-mode ではない verifier success のみ。
- **journal**: zkVM の公開出力（集計結果・整合性情報など）
- **input**: zkVM 入力（witness を含む。公開禁止）
- **public-input**: input から witness を除いた公開入力
- **verification.json**: verifier-service の full report。public `bundle.zip` には含めず、session capability で保護された `/report` endpoint からのみ配布する
- **bundle.zip**: 公開可能な証拠だけを収録したパッケージ
- **executionId**: finalize 実行単位の識別子

## フローと endpoint/auth 契約

通常フローは、session 作成、投票、finalize、検証情報取得、必要に応じた STARK 検証、browser-local
cast check の最終観測、の順です。session-scoped endpoint の認証方式は次の表を単一の参照先とします。

| Endpoint                                                         | 用途                                  | session scope / auth                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`                                              | session 作成                          | 認証なし。`sessionId` と `capabilityToken` を返す                                                                                             |
| `POST /api/vote`                                                 | user / Bot 投票                       | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `GET /api/progress`                                              | Bot 投票進捗                          | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `POST /api/finalize`                                             | zkVM 実行、bundle 生成・保存          | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `POST /api/finalize/cancel`                                      | finalize の取消                       | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `GET /api/verify`                                                | 検証情報、step、check の取得          | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `POST /api/verification/run`                                     | server-side STARK 検証                | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `POST /api/verification/observation`                             | browser-local cast check の最終観測   | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `GET /api/bulletin`                                              | owner-scoped inspection/debug         | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `GET /api/bulletin/:voteId/proof`                                | session-authorized な個票 CT proof    | `X-Session-ID` + `X-Session-Capability`。その session の user vote、または S3/S4 の `tamperSummary.affectedBotIds` に含まれる Bot vote に限定 |
| `GET /api/bulletin/consistency-proof`                            | consistency proof の building block   | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `GET /api/bitmap-proof`                                          | user vote の bitmap proof             | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `GET /api/sth`                                                   | third-party STH 照合用データ          | `X-Session-ID` + `X-Session-Capability`                                                                                                       |
| `GET /api/zkvm-input-hash?sessionId=...`                         | hash-only evidence                    | query の `sessionId` + `X-Session-Capability`。`X-Session-ID` は不要                                                                          |
| `GET /api/sessions/:sessionId/status`                            | async finalize status                 | path の `sessionId` + `X-Session-Capability`。`X-Session-ID` は不要                                                                           |
| `GET /api/verification/bundles/:sessionId/:executionId[/report]` | bundle または protected report の取得 | path の `sessionId` + `X-Session-Capability`。`X-Session-ID` は不要                                                                           |

header-driven endpoint の形式:

```http
X-Session-ID: <sessionId>
X-Session-Capability: <capabilityToken>
```

`GET /api/bulletin/:voteId/proof` は ownership 制約に違反すると `VOTE_NOT_FOUND` で fail closed します。
`GET /api/zkvm-input-hash` の truthy `includeData` variant は `ROUTE_RETIRED` です。Retired contract
metadata は fail-closed test のため残りますが、`GET /api/botdata/:id` は Hono route inventory に
登録されていません。

## `/api/verify`

### Query

- `includeJournal=1`: `journal` を含め、`journalStatus=available` を返す
- 省略時: `journal` を含めず、`journalStatus=omitted` を返す
- `refreshS3` は public contract 外であり、strict route validation で reject する

`includeBulletin` は存在しません。Bulletin は `/api/bulletin` または
`/api/bulletin/:voteId/proof` から取得します。

### Response

主要 response field:

- 識別: `electionId`, `electionConfigHash`, `logId`
- scenario / presentation: `scenarioId`, `imageId`, `tamperDetected`, `tamperSummary`
- tally: `tally { counts, totalVotes, tamperedCount }`, `verifiedTally`
- 公開 parameter: `bulletinRoot`, `treeSize`, `totalExpected`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `seenIndicesCount`
- count mirror: `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`
- user vote: `voteReceipt`, `userVote`
- 検証状態: `verificationStatus`, optional sanitized `verificationReport`
- 実行識別: `verificationExecutionId`
- UI: `verificationSteps`, `verificationChecks`
- journal: `journalStatus` と、要求時のみ `journal`

`voteReceipt` と `userVote.proof` は、store から exact cast-time CT artifact を再構成できた場合に
だけ含まれます。exact proof がなくても `/api/verify` は `200` を維持し、field を省略したまま
recorded inclusion/consistency check を `not_run` / `missing_evidence` 側へ fail closed します。

`publicInputArtifact` 由来の `publicInputAuthority`, `electionManifest`, `closeStatement`,
`scenarios`, `s3BundleKey` は top-level response に含めません。server-side の検証入力、bundle
artifact、または内部 metadata として使用します。

browser / CLI の download selector authority は `verificationExecutionId` です。consumer は
session context と `verificationExecutionId` から
`/api/verification/bundles/:sessionId/:executionId` を derive します。current-generation の
finalized authority では安全な top-level `verificationExecutionId` が必須で、missing / unsafe
な値は `corrupt_or_unreadable` として fail closed します。
`verificationResult.executionId` への fallback は行いません。
`verificationBundleUrl` / `verificationReportUrl` / `s3BundleUrl` / `refreshS3` も
top-level public contract には含まれません。

### Authority と count semantics

- `journal` が canonical な proof-bound payload です。canonical `journal` は `missingIndices` / `invalidIndices` / `countedIndices` / `excludedCount` を持ちません。
- `verifiedTally`, `bulletinRoot`, `sthDigest`, `seenIndicesCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `treeSize`, `totalExpected` などの top-level mirror は互換維持用の派生/cache field であり、`journal` と一致しなければなりません。
- `publicInputAuthority`, `electionManifest`, `closeStatement` は journal-derived cache ではありません。input-side authority、election-config-derived artifact、hybrid artifact として独立した整合性規則を持ち、handler は `counted_*` check の内部入力に使います。
- `tally`, `tamperDetected`, `tamperSummary`, `scenarioId`, `verification*` は presentation / control state であり、proof-derived cache ではありません。
- top-level `imageId` は verifier 実行前の host-provided claim です。`journal.imageId` は comparison-only metadata であり、canonical proof output ではありません。verifier 実行後は full report の `receipt_image_id` が proved identity です。
- `missingSlots`: guest に提示されなかった bulletin slot 数
- `invalidPresentedSlots`: 提示された in-range slot のうち計上に失敗した slot 数
- `rejectedRecords`: 提示された record のうち検証で reject された record 数
- `excludedSlots`: slot-based の fail-closed signal。`> 0` なら全体検証は失敗する

legacy `missingIndices` / `invalidIndices` / `countedIndices` / `excludedCount` は public response から
retire されています。loose boundary や stale local cache で受ける場合も canonical `journal` /
current slot field に畳み込むだけで、再公開しません。個票の状態は count field だけで説明せず、
`seenBitmapRoot` / `includedBitmapRoot` と private bitmap artifact を使います。

### Fail-closed response

supported current finalized authority を復元できる場合は `200` を返します。
`unsupported_current_artifact` と `corrupt_or_unreadable` は、現行実装では
`200` + `error` + `message` + `artifactState` の JSON payload で fail closed します。

`SESSION_NOT_FINALIZED` や `USER_NOT_VOTED` などの auth / capability / precondition failure は
`400` 系です。詳細な finalized-artifact contract は `verify.ts`, `verificationRun.ts`,
`sessionStatus.ts`, bundle download route の tests を source of truth とします。

## `/api/verification/run`

`POST /api/verification/run` は expected ImageID を解決し、`Receipt::verify(expectedImageId)` を
実行します。

- authoritative な `s3BundleKey` がある場合は `verification-worker` を使う。AWS target runtime では verification work を queue に投入する
- S3 authority がなく trusted local bundle を解決できる場合は、local bundle を直接 `verifier-service` に渡す
- verifier の full report は protected `verification.json` として保存する
- DynamoDB-backed runtime は full report を session row に保持せず、status、failure category、`devModeReceipt`、artifact locator などの bounded metadata だけを保持する
- そのため `/api/verify` の sanitized `verificationReport` は optional で、bounded persistence 後は通常利用できない。full report の唯一の配布 contract は authenticated `/report` endpoint

`stark_receipt_verify` は required check ですが、それだけで全体を Verified にすることはできません。

## `/api/verification/observation`

`POST /api/verification/observation` は verdict authority ではありません。画面で確定した
browser-local cast check と server authority を結合し、最終 verification summary を
CloudWatch 用に観測する endpoint です。

request body は current `verificationExecutionId` と、次の4 check の status だけを受け付けます。

- `cast_receipt_present`
- `cast_choice_range`
- `cast_random_format`
- `cast_commitment_match`

全4キーが必須で、status は `success | failed | not_run` の閉じた集合です。choice、random、
commitment、receipt、capability token、Cookie、scenario、summary、server-side check は本文に
含めません。server は session capability と current finalized execution の一致を確認し、残りの
check、STH requirement、slot context、scenario、verifier failure category、dev-mode evidence を
server authority から再構成します。DynamoDB はこの観測に必要な `devModeReceipt` boolean を
bounded metadata として保持しますが、full verification report は保持しません。

同一 execution では最初の観測だけを session store の conditional record で受理します。
同じ fingerprint の再送は idempotent、異なる fingerprint と stale execution は dedicated `409`
conflict です。いずれも event を二重 emit しません。marker は full-session の stale write でも
消えない persistence guard に含めます。CAS 成功後に event emit を最大1回試みますが、
CloudWatch delivery の exactly-once 保証ではありません。

この観測は画面の verdict を gate、変更しません。browser は同じ fingerprint に対する
deterministic 4xx を terminal とし、`408` / `425` / `429`、network failure、5xx だけを
dependency state が変わったときに best-effort で再試行します。timer polling は行いません。

## 検証 check と verdict authority

check ID と base metadata の authority は
`packages/verification/src/verification/verification-checks.ts` です。

```text
Cast:    cast_receipt_present, cast_choice_range, cast_random_format, cast_commitment_match
Recorded: recorded_commitment_in_bulletin, recorded_index_in_range, recorded_root_at_cast_consistent,
         recorded_inclusion_proof, recorded_consistency_proof, recorded_sth_third_party
Counted: counted_input_sanity, counted_unique_indices, counted_unique_commitments, counted_tally_consistent,
         counted_missing_indices_zero, counted_expected_vs_tree_size, counted_election_manifest_consistent,
         counted_close_statement_consistent, counted_my_vote_included, counted_input_commitment_match
STARK:   stark_image_id_match, stark_receipt_verify
```

- base required checks は Cast 4 checks、`recorded_index_in_range`, `recorded_inclusion_proof`, `recorded_consistency_proof`、Counted 10 checks、`stark_image_id_match`, `stark_receipt_verify`
- `recorded_sth_third_party` は通常 optional だが、STH source が設定されている場合は effectively required となり blocking
- required check の failed、`not_run`、`pending`、`running`、または欠落は fully verified を block
- `recorded_consistency_proof`, `counted_missing_indices_zero`, `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`, `counted_close_statement_consistent`, `counted_my_vote_included`, `counted_input_commitment_match`, `stark_image_id_match`, `stark_receipt_verify` は hard-failure signal
- `excludedSlots > 0` は成功を block する。legacy `excludedCount > 0` は compatibility 入力を fail closed に扱うためだけの signal であり、public contract には戻さない

`recorded_as_cast` / `counted_as_recorded` / `stark_verification` の step status は、その stage で
required となる check 群から server-side に導出します。`cast_as_intended` は `/api/verify` では
`castSource='client'` のため server-side で `not_run` とし、verify page が browser 保存済みの
receipt/opening から local check を再計算します。`verificationSteps[].inputs` は stage 内の全
check 定義から集約した UI highlight key です。

summary authority は `packages/verification/src/verification/verification-summary.ts` です。
`verificationChecks` と `missingSlots/invalidPresentedSlots/rejectedRecords/excludedSlots` の context
を受け取り、次の規則を適用します。

- required check の欠落は `missing_evidence`
- STH は source 設定時だけ blocking
- missing と invalid の違いは説明文で表し、check 数は増やさない
- `counted_tally_consistent`（role: `tally_consistency`）だけが失敗し、proof、inclusion、completeness、input integrity が成功した場合は `published_tally_mismatch`

## STH（third-party 照合）

- browser 設定は `VITE_STH_SOURCES` と `VITE_STH_MIN_MATCHES`
- 相対 URL は検証 request の origin に対して解決する
- same-origin `/api/sth` にだけ session auth header を送る
- cross-origin source に session capability を送らない
- source 設定時は consensus threshold を満たさない failure が Verified を block する。未設定時は optional
- `/api/sth` は `sth-verifier` が読む `{ sth: { ... } }` を返す

## Bitmap proof（個票 explainability）

- `GET /api/bitmap-proof?i=&kind=included|seen` は `leafChunk` + `auditPath` を返す
- `kind` の default は `included`
- `included` は counted された index、`seen` は prover に提示された index
- bitmap は LSB-first で pack し、bit `i` は byte `i / 8` の bit position `i % 8`
- 通常の API usage では `i` を session の user vote index に限定する。隣接 slot や任意 index の inspection route はない
- proof source がある場合、現行 PoC の verification flow は proof を自動取得しうる。明示同意 gate はない
- client が `leafChunk` から bit を解釈する
- 保存 bitmap の root が journal と一致しなければ proof を無効化する
- `seenBitmapRoot` がある場合、`counted_my_vote_included` は `included` と `seen` を組み合わせて `presented and counted` / `presented but invalid` / `not presented to the prover` を説明する
- response は private cache として24時間 `immutable`

## Proof bundle

### Bundle directory artifacts

- `input.json`（private witness）
- `public-input.json`
- `election-manifest.json`
- `close-statement.json`
- `journal.json`
- `receipt.json`
- `metadata.json`（sync のみ）
- `verification.json`（protected full report）
- `included-bitmap.json`（private exact counted bitmap）
- `seen-bitmap.json`（private exact presented bitmap）

### Public `bundle.zip` allowlist

sync:

```text
public-input.json, election-manifest.json, close-statement.json, receipt.json, journal.json, metadata.json
(+ optional) sth.json, consistency-proof.json
```

async:

```text
public-input.json, election-manifest.json, close-statement.json, receipt.json, journal.json
```

public bundle に絶対含めない artifact:

```text
input.json, verification.json, included-bitmap.json, seen-bitmap.json
```

`included-bitmap.json` は `/api/bitmap-proof` の trusted source、`seen-bitmap.json` は per-index
explainability の source です。sync / async とも finalization 時点の exact counted/presented
bitmap を private に保存します。

`bundle.zip` は bundle-only audit 用で、`/verify` UI の verdict を単体では完全再現しません。
UI verdict には session-scoped bulletin proof、bitmap proof、設定時の third-party STH evidence
も関わります。これは private artifact を漏らさないための意図的な PoC 境界です。公開向けの
audit 手順は `public-book/src/reproducibility/index.md` を参照してください。

## Bundle/report delivery

- `GET /api/verification/bundles/:sessionId/:executionId` は `bundle.zip` を返す
- `GET /api/verification/bundles/:sessionId/:executionId/report` は protected `verification.json` を返す
- path の execution は finalized authority の `verificationExecutionId` と一致しなければならない
- authoritative な `s3BundleKey` / `s3ReportKey` があり S3 配布が有効なら、authenticated route が S3 から artifact を取得する
- S3-backed `bundle.zip` は `Accept-Ranges: bytes` を返す。browser / CLI は byte-range response を結合し、4 MiB を超える bundle の range なし request は fail closed する
- `/report` は small protected JSON を通常 body で返す。S3-backed report が 4 MiB を超える場合は hosted payload limit を避けるため fail closed する
- authoritative S3 key がない local runtime では、同じ authenticated route が trusted local artifact を返す
- browser / CLI は raw S3 URL や S3 redirect を public download contract として使わない

## 参考ドキュメント

- `docs/zkvm/final-design.md`
- `docs/ui/verify-page/verify-page.md`
- `docs/ui/api-contract.md`
- `docs/ui/knowledge-panel.md`
