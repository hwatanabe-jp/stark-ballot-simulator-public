# STARK Ballot Simulator 検証バンドル & 検証フロー（現行実装）

このドキュメントは **現行コードに基づく実装仕様** をまとめたものです。設計案や計画ではなく、
`apps/` / `packages/` / `infra/docker/` / `infra/terraform/` が示す挙動を唯一の真実とします。

## 実装の参照先

| 対象                                        | 実装                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 検証ステップ/チェック生成                   | `packages/verification/src/verification/build-verification-steps.ts`, `packages/verification/src/verification/build-verification-checks.ts`                                                                                                                                                                                                               |
| チェック定義                                | `packages/verification/src/verification/verification-checks.ts`                                                                                                                                                                                                                                                                                           |
| evidence acquisition / check context        | `packages/verification/src/verification/engine/{types,admit-evidence,evaluate-checks}.ts`                                                                                                                                                                                                                                                                 |
| verification resource GET                   | `apps/api/src/server/api/handlers/verify.ts`                                                                                                                                                                                                                                                                                                              |
| verification resource POST                  | `apps/api/src/server/api/handlers/verificationRun.ts`                                                                                                                                                                                                                                                                                                     |
| verification observation POST               | `apps/api/src/server/api/handlers/verificationObservation.ts`                                                                                                                                                                                                                                                                                             |
| shared presentation policy                  | `packages/verification/src/verification/verification-presentation-policy.ts`                                                                                                                                                                                                                                                                              |
| verifier report / process protocol          | `packages/verification/src/verification/verifier-service-report.ts`, `packages/node-adapters/src/verifier-service-client.ts`                                                                                                                                                                                                                              |
| browser-local cast checks                   | `packages/verification/src/verification/local-cast-checks.ts`、`apps/web/src/routes/verify/lib/local-cast-evidence.ts`                                                                                                                                                                                                                                    |
| bundle/report 配布                          | `packages/application/src/verification/artifact-reader.ts`、`packages/node-adapters/src/local-artifact-reader.ts`、`packages/aws-adapters/src/aws/s3-artifact-reader.ts`、`apps/api/src/server/api/handlers/verificationBundles.ts`                                                                                                                       |
| public bundle manifest                      | `packages/verification/src/verification/public-bundle-manifest.{json,ts}`                                                                                                                                                                                                                                                                                 |
| sync artifact payload / ZIP 生成・admission | `packages/verification/src/verification/verification-bundle.ts`（pure payload）、`packages/node-adapters/src/verification-bundle.ts`（永続化・ZIP 生成・completed-archive admission）                                                                                                                                                                     |
| S3 artifact publication                     | `packages/aws-adapters/src/finalize/publish-verification-artifacts.ts`、`apps/api/src/server/composition/finalizationDependencies.ts`（sync policy の注入）                                                                                                                                                                                               |
| browser / CLI artifact response admission   | `packages/api-contract/src/http/artifact-response.ts`                                                                                                                                                                                                                                                                                                     |
| async bundle 生成                           | `infra/docker/entrypoint.sh`                                                                                                                                                                                                                                                                                                                              |
| bitmap proof / sidecar admission            | `packages/zkvm-contract/src/zkvm/bitmap-core.ts`、`packages/verification/src/merkle/bitmap-merkle-tree.ts`、`packages/application/src/finalize/{finalization-bitmap-admission,finalization-store}.ts`、`packages/aws-adapters/src/store/{dynamoSessionStore,fileMockSessionStore,mockSessionStore}.ts`、`apps/api/src/server/api/handlers/bitmapProof.ts` |
| finalization state / persisted codec        | `packages/application/src/finalize/{finalization-types,finalization-storage,finalization-record}.ts`                                                                                                                                                                                                                                                      |
| STH                                         | `apps/api/src/server/api/handlers/sth.ts`                                                                                                                                                                                                                                                                                                                 |

## 用語

- **receipt**: zkVM 実行の receipt artifact（`Receipt::verify(expectedImageId)` 対象）。`RISC0_DEV_MODE=1` の fake receipt は開発用 artifact であり、production STARK proof evidence ではない。Production STARK proof evidence として扱えるのは、dev-mode ではない verifier success のみ。
- **journal**: zkVM の公開出力（集計結果・整合性情報など）。`journal.json` は Rust host が receipt を decode して投影した JSON であり、opaque な receipt serde bytes や固定 packed layout ではない
- **input**: zkVM 入力（witness を含む。公開禁止）
- **public-input**: input から witness を除いた公開入力
- **verification.json**: verifier-service の full report。public `bundle.zip` には含めず、session capability で保護された `/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report` からのみ配布する
- **bundle.zip**: 公開可能な証拠だけを収録したパッケージ
- **finalizationId**: create、current lifecycle、verification work、observation、bundle/report
  locator を一貫して識別する唯一の repository lifecycle ID。event の snake_case field は
  `finalization_id` で、nested verification identity へ fallback しない

## フローと endpoint/auth 契約

通常フローは、session 作成、投票、finalize、検証情報取得、必要に応じた STARK 検証、browser-local
cast check の最終観測、の順です。session-scoped endpoint の認証方式は次の表を単一の参照先とします。

| Endpoint                                                                                | 用途                                | session scope / auth                                                                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions`                                                                    | session 作成                        | 認証なし。`sessionId`、`capabilityToken`、`electionId`、`electionConfigHash`、`logId` を返す                                                       |
| `POST /api/sessions/:sessionId/votes`                                                   | user / Bot 投票                     | path の `sessionId` + `X-Session-Capability`                                                                                                       |
| `GET /api/sessions/:sessionId/progress`                                                 | Bot 投票進捗                        | path の `sessionId` + `X-Session-Capability`                                                                                                       |
| `POST /api/sessions/:sessionId/finalizations`                                           | zkVM 実行、bundle 生成・保存        | path の `sessionId` + `X-Session-Capability`                                                                                                       |
| `POST /api/sessions/:sessionId/finalizations/:finalizationId/cancel`                    | finalize の取消                     | path の `sessionId` / `finalizationId` + `X-Session-Capability`。identity を body に重複させない                                                   |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification`               | strict verification resource        | path の `sessionId` / `finalizationId` + `X-Session-Capability`                                                                                    |
| `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification`              | server-side STARK 検証              | path の `sessionId` / `finalizationId` + `X-Session-Capability`。body は strict `{}`                                                               |
| `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations` | browser-local cast check の最終観測 | path の `sessionId` / `finalizationId` + `X-Session-Capability`。body に identity を重複させない                                                   |
| `GET /api/sessions/:sessionId/bulletin`                                                 | owner-scoped inspection/debug       | path の `sessionId` + `X-Session-Capability`                                                                                                       |
| `GET /api/sessions/:sessionId/votes/:voteId/inclusion-proof`                            | session-authorized な個票 CT proof  | path の `sessionId` + `X-Session-Capability`。その session の user vote、または S3/S4 の `tamperSummary.affectedBotIds` に含まれる Bot vote に限定 |
| `GET /api/sessions/:sessionId/bulletin/consistency-proof`                               | consistency proof の building block | path の `sessionId` + `X-Session-Capability`                                                                                                       |
| `GET /api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex`     | user vote の bitmap proof           | path の `sessionId` + `X-Session-Capability`。`kind` と `voteIndex` も path から取得                                                               |
| `GET /api/sessions/:sessionId/bulletin/sth`                                             | same-origin STH 照合用データ        | path の `sessionId` + `X-Session-Capability`                                                                                                       |
| `GET /api/sessions/:sessionId/finalizations/current/input-commitment`                   | hash-only evidence                  | path の `sessionId` + `X-Session-Capability`。private input selector は存在しない                                                                  |
| `GET /api/sessions/:sessionId/finalizations/current`                                    | current finalization resource       | path の `sessionId` + `X-Session-Capability`                                                                                                       |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`           | public bundle の取得                | path の `sessionId` / `finalizationId` + `X-Session-Capability`                                                                                    |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`           | protected report の取得             | path の `sessionId` / `finalizationId` + `X-Session-Capability`                                                                                    |

public non-artifact JSON success は `{ data, meta: { requestId } }`、JSON error は
`{ error: { code, message, details? }, meta: { requestId } }` を返します。`details` は strict tagged
union で、HTTP status は JSON に重複させません。raw `bundle.zip`、protected `verification.json`、
internal finalize callback protocol は明示的な例外です。

3 つの verification route はすべて path の `sessionId` と `finalizationId` を唯一の identity
authority とし、credential は `X-Session-Capability` だけです。

`GET /api/sessions/:sessionId/votes/:voteId/inclusion-proof` は ownership 制約に違反すると
`VOTE_NOT_FOUND` で fail closed します。input-commitment route には query selector がなく、
private input を返す route variant や compatibility parser もありません。browser/CLI API
には bot vote opening を返す route もありません。

Finalization create の sync `200` / async `202` と current `GET` は同じ strict
`FinalizationResource` union を返します。全 variant は `finalizationId`, `queuedAtMs`,
`runtimeDiagnostics` を持ち、status に応じて `startedAtMs`, `completedAtMs`, `failedAtMs`,
`timeoutAtMs` を要求します。succeeded の `result` は proof-bound `authority`、derived
`presentation`、`available | verification-gated` の discriminated
`voterEvidence`、`artifactAvailability` に partition されます。
bitmap の `available` は terminal success と同じ durable commit に admit された sidecar だけを表します。
queue/progress estimate は `runtimeDiagnostics` にだけ置き、finalization/proof authority にしません。
集計 GET は保存済み状態だけを返し、実行基盤の状態照合は定期 writer が担います。

application 内では public-audit 3点、receipt、receipt publication、bitmap evidence をそれぞれ
`available | unavailable` の閉じた状態として扱います。file/DynamoDB の既存 flat record は変更せず、
application-owned pure codec がこの1つの exact-current 保存形と internal union の間を
encode/decode します。adapter は I/O だけを所有し、別の parser、key list、compatibility reader、
dual writer を持ちません。

public finalization schema は authority、journal、report、public-audit、voter evidence、bitmap、
tamper/scenario の重複事実を相互照合します。矛盾した payload を補正・正規化せず、external JSON
admission で reject します。

`POST /api/internal/sessions/:sessionId/finalizations/:finalizationId/callback` は API-local
internal HMAC route で、public route inventory、browser contract、API Gateway/Lambda mode には
含めません。path と payload の session/finalization identity は一致しなければなりません。

## `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification`

### Query

- `include=journal`: `journal = { representation: "included", value }` を返す
- 省略時: `journal = { representation: "omitted" }` を返す
- `refreshS3` は public contract 外であり、strict route validation で reject する

`includeBulletin` は存在しません。Bulletin は
`/api/sessions/:sessionId/bulletin`、個票の exact CT material は
`/api/sessions/:sessionId/votes/:voteId/inclusion-proof` から取得します。

### Response

response は strict availability discriminator を持ちます。`availability: "available"` の
`data` は次の group に partition され、flat field fallback はありません。

- `finalizationId`: path と一致する lifecycle authority
- `proofAuthority`: `electionId`, `electionConfigHash`, `logId`, `imageId`, proof-bound tally/count/root values
- `presentation`: claimed `tally`, `scenarioId`, tamper presentation、および shared `policy`
- `verifierResult`: `verificationStatus` 相当の `status` と optional sanitized `report`
- `verification`: `checks` と `steps`
- `voterEvidence`: `available | unavailable` の exact voter-evidence discriminator
- `journal`: `included | omitted` の representation discriminator

available resource の schema は proof authority、included journal、verifier report、canonical
checks/steps、voter evidence、presentation policy、tamper/scenario を相互照合します。required check
や tally、ImageID、Merkle evidence の矛盾を正規化せず、JSON admission で reject します。

`voterEvidence.availability="available"` のときだけ exact `voteReceipt` と proof-bearing
`userVote` を返します。exact proof を再構成できない場合も `200` を維持しますが、
`voterEvidence.availability="unavailable"` と reason を返し、関連 check は
`not_run` / `missing_evidence` 側へ fail closed します。

`publicInputArtifact` 由来の `publicInputAuthority`, `electionManifest`, `closeStatement`,
`scenarios`, `s3BundleKey` は top-level response に含めません。server-side の検証入力、bundle
artifact、または内部 metadata として使用します。

browser / CLI の download selector authority は `finalizationId` です。consumer は
session context と `finalizationId` から
`/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle` または
`/artifacts/report` を derive します。admitted finalization record には path と一致する安全な
top-level `finalizationId` が必須です。requested ID が current finalization と異なる場合は
`availability: "unavailable"` / `reason: "finalization_not_current"`、record 自体が invalid な
場合は `availability: "corrupt"` / `reason: "invalid_artifact"` として fail closed します。
`verificationResult.finalizationId` への fallback は行いません。
`verificationBundleUrl` / `verificationReportUrl` / `s3BundleUrl` / `refreshS3` も
top-level public contract には含まれません。

### Authority と count semantics

- `journal.value` が、`include=journal` で要求したときの canonical proof-bound payload です。
- `proofAuthority` の `verifiedTally`, `bulletinRoot`, `sthDigest`, `seenIndicesCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `treeSize`, `totalExpected` は admitted journal authority から project されます。
- `publicInputAuthority`, `electionManifest`, `closeStatement` は journal-derived cache ではありません。input-side authority、election-config-derived artifact、hybrid artifact として独立した整合性規則を持ち、handler は `counted_*` check の内部入力に使います。
- `presentation.tally`, `tamperDetected`, `tamperSummary`, `scenarioId` は presentation state であり、proof authority ではありません。
- `proofAuthority.imageId` は host-provided claim です。`journal.imageId` は comparison-only metadata であり、canonical proof output ではありません。production verification が `success` となり、report の `expected_image_id` と `receipt_image_id` が一致した場合に、その `receipt_image_id` を proved identity として扱います。
- `missingSlots`: guest に提示されなかった bulletin slot 数
- `invalidPresentedSlots`: 提示された in-range slot のうち計上に失敗した slot 数
- `rejectedRecords`: 提示された record のうち検証で reject された record 数
- `excludedSlots`: slot-based の fail-closed signal。`> 0` なら全体検証は失敗する

journal / proof authority の count と tally の各値は `uint32`（0–4,294,967,295）、
`treeSize` は正の `uint32` です。加算結果も safe integer として検査し、次の関係を要求します。

- `sum(verifiedTally) + invalidPresentedSlots = seenIndicesCount`
- `seenIndicesCount + missingSlots = treeSize`
- `missingSlots + invalidPresentedSlots = excludedSlots`
- `rejectedRecords >= invalidPresentedSlots`
- `invalidPresentedSlots = 0` なら `seenBitmapRoot = includedBitmapRoot`

journal ではさらに `sum(verifiedTally) = validVotes`、`validVotes + invalidVotes = totalVotes`、
`rejectedRecords = invalidVotes` を要求します。`totalExpected` と `treeSize` の不一致は
検証失敗を表す証拠として admission でき、成功判定では `counted_expected_vs_tree_size` が検出します。
公開 `presentation.tally` も各値を `uint32` に限定し、A–E の合計と `totalVotes` の一致を要求します。
公開 tally と proof tally の一致は `counted_tally_consistent` が検証します。

legacy `missingIndices` / `invalidIndices` / `countedIndices` / `excludedCount` は public response から
retire されています。current journal の server/browser admission はこれらを reject し、
canonical field への修復、正規化、fallback を行いません。untyped な journal-like payload を
扱う defensive sanitizer は、これらの存在を検出した場合に terminal success を `failed` へ
downgrade するだけで、その payload を current journal として admission / projection しません。
これは malformed state の fail-closed 検出であり、旧 shape の reader ではありません。個票の
状態は count field だけで説明せず、`seenBitmapRoot` / `includedBitmapRoot` と private bitmap
artifact を使います。

### Fail-closed response

verification read の準備結果は `200` の success envelope 内で fail closed します。
`availability: "unavailable"` の reason は `finalization_not_current |
user_vote_unavailable`、`availability: "corrupt"` の reason は `invalid_artifact |
incomplete_session_authority | session_identity_mismatch | voter_evidence_mismatch` です。どちらも
`finalizationId`, `reason`, 安全な `message` を返します。UI/CLI admission は未知または malformed
な resource も `reason: "invalid_artifact"` の `corrupt` に畳み込み、Verified にしません。

`SESSION_NOT_FINALIZED` や `USER_NOT_VOTED` などの auth / capability / precondition failure は
`400` 系です。詳細な finalized-artifact contract は `verify.ts`, `verificationRun.ts`,
`currentFinalization.ts`, bundle download route の tests を source of truth とします。

## `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification`

この strict-empty-body POST は path の current `finalizationId` に対して expected ImageID を
解決し、`Receipt::verify(expectedImageId)` を実行するか、同じ finalization の既存状態を
idempotent に返します。running は再送も `202`、terminal は `200` です。
古い finalization ID の検証 POST は `409 FINALIZATION_NOT_CURRENT` で拒否します。

- AWS target runtime の authoritative `s3BundleKey` は
  `recordType: "verification-work"` と current `finalizationId` を持つ exact work item として
  verification queue に投入し、queue-triggered `verification-worker` が処理する。API は worker
  Lambda を同期 invoke しない
- local profile は S3 locator を受理せず、trusted local bundle だけを直接
  `verifier-service` に渡す。artifact backend と profile の混在は fail closed する
- verifier の full report は protected `verification.json` として保存する
- DynamoDB-backed runtime は verification state を session identity / voting /
  finalization item へ混在させず、`sessionId` と current `finalizationId` で scope した exact
  verification-result record に保存する。verifier が report を返した terminal result では、
  admitted report もこの record に含まれる
- GET verification resource の `verifierResult.report` は状態により optional だが、report を
  browser / CLI へ artifact として配布する唯一の contract は capability で保護された
  `/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report` である。Dynamo record
  の存在は public bundle や unauthenticated report delivery を許可しない

verifier-service report の wire authority は verification package の1つの exact schema です。
`bundle_path` / `receipt_path` を含む protected wire artifact をそこで admit し、application/public
向けには path field を落とす named projection を使います。`duration_ms` は JavaScript safe integer、
ImageID、RFC 3339 timestamp、basename-only path、status ごとの `errors` / `dev_mode_receipt` の
相関を同じ parser が検証します。success report は `expected_image_id = receipt_image_id`、
dev-mode report は `receipt_image_id` が null でない場合に同じ一致を要求します。
verification resource は failed report を含め、存在する report の `expected_image_id` と
`proofAuthority.imageId` も照合します。Node process protocol が受理する組は
`0/success`, `2/dev_mode`, `3/failed` だけです。exit `1`、report `null`、未知の exit code、
malformed report、exit/status mismatch は report を trusted state に入れる前に fail closed します。

保存される verification result も status-specific union です。`not_run` / `running` は report を
持てず、terminal report がある場合は result status と一致しなければなりません。
success/dev-mode に infrastructure failure category を付けることや、failed result に `none` を
付けることは admission で拒否します。report を持たない intentional mock/status-only state は
この相関を緩める compatibility shape ではなく、union の明示 branch です。

`stark_receipt_verify` は required check ですが、それだけで全体を Verified にすることはできません。

## `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`

この endpoint は、画面で確定した browser-local cast check と server authority を結合し、
最終 verification summary を CloudWatch 用に観測します。verdict の決定は共有の
検証表示ポリシーが担い、観測の送信結果によって変わりません。

`finalizationId` は path だけから取得します。request body は `castChecks` object 内の
次の4 check status だけを受け付けます。

- `cast_receipt_present`
- `cast_choice_range`
- `cast_random_format`
- `cast_commitment_match`

全4キーが必須で、status は `success | failed | not_run` の閉じた集合です。choice、random、
commitment、receipt、capability token、Cookie、scenario、summary、server-side check は本文に
含めません。server は session capability と current finalized finalization の一致を確認し、残りの
check、STH requirement、slot context、scenario、verifier failure category、dev-mode evidence を
server authority から再構成します。DynamoDB の verification-result record は admitted report
を保持し得ますが、verification-observation record は proof/finalization authority や report を
複製せず、観測 fingerprint と idempotency metadata だけを保持します。

同一 finalization では最初の観測だけを session store の conditional record で受理します。
同じ fingerprint の再送は idempotent、異なる fingerprint と stale finalization は dedicated `409`
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
- `recorded_consistency_proof`, `counted_missing_indices_zero`, `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`, `counted_close_statement_consistent`, `stark_receipt_verify` の failed は hard-failure signal
- `counted_my_vote_included`, `counted_input_commitment_match`, `stark_image_id_match` も required であり、失敗は fully verified を block する。`stark_image_id_match` と `stark_receipt_verify` の failed は explicit proof failure としても判定する
- `missingSlots` / `invalidPresentedSlots` / `excludedSlots` が正数、非負 safe integer の範囲外、または3値の partition が不整合の場合も hard-failure signal

`recorded_as_cast` / `counted_as_recorded` / `stark_verification` の step status は、その stage で
required となる check 群から server-side に導出します。`cast_as_intended` は GET verification resource では
`castSource='client'` のため server-side で `not_run` とします。verify page は admitted
verification resource の `voterEvidence` から receipt を取得し、browser session の
`electionId` / `myVote` / `myRand` と組み合わせて local check を再計算します。

summary、stage status、fully-verified label eligibility、display precedence の単一 authority は
`packages/verification/src/verification/verification-presentation-policy.ts` です。browser-local
cast calculation は `local-cast-checks.ts` が所有し、web は local result を server checks に
overlay して同じ policy を再評価します。policy は checks と
`missingSlots/invalidPresentedSlots/rejectedRecords/excludedSlots` context を受け取ります。

browser の `useVerificationSequence.ts` は、必要な STARK 検証の開始・polling を終えた後、
取得済みの最新 payload から4 stage を一括表示します。表示用 timer による段階的な演出は
ありません。待機後に開始時の session identity を再確認し、現在の session に対して
`user.voteReceipt` / `user.merklePath` を保存します。unmount、session replacement、または
verification continuation authority の失効で中断した場合は、遅れて返った結果から evidence や
完了状態を公開しません。これらの evidence は検証開始前には表示しません。

`verification.steps[].inputs` は stage 内の全 check 定義から集約した canonical metadata です。
現在の検証カードは各 check の `inputs` を使って、その check に対応する inline evidence を
選択します。画面での表示と操作の詳細は
[検証画面仕様](../ui/verify-page/verify-page.md) を参照してください。

engine は identity/config、artifact acquisition、proof outcome、user receipt を independently
admitted な discriminated state として合成し、各 check には必要な context だけを渡します。
check result も status-specific で、success に failure detail を付ける、not-run に成功 evidence を
付ける、といった組み合わせは構築できません。fully verified branch は presentation policy 内の
private witness を持ち、required checks、hard-failure、development evidence、display status を
すべて確認した policy だけが生成できます。web はこの branch に narrow した場合だけ
「Verified」を表示します。

public resource の admission も fully-verified label eligibility を再検証します。S0、production
verifier success、整合する available voter evidence、全 required checks / stage の成功に加え、
次の公開事実が必要です。

- `missingSlots = invalidPresentedSlots = rejectedRecords = excludedSlots = 0`
- `treeSize = totalExpected = seenIndicesCount`、`seenBitmapRoot = includedBitmapRoot`
- 公開 tally の各候補数と合計が proof tally と一致
- tamper detection が false、`tamperedCount = 0`、存在する tamper summary に改ざんの事実がない

report、included journal、check metadata / status、step、presentation policy の矛盾は
fully-verified branch 以外でも reject します。status-only success は ImageID check の成功を
満たさないため、それだけでは Verified になりません。

- required check の欠落は `missing_evidence`
- missing と invalid の違いは説明文で表し、check 数は増やさない
- `counted_tally_consistent`（role: `tally_consistency`）だけが失敗し、proof、inclusion、completeness、input integrity が成功した場合は `published_tally_mismatch`

## STH（third-party 照合）

- browser 設定は `VITE_STH_SOURCES` と `VITE_STH_MIN_MATCHES`
- same-origin source は exact template
  `/api/sessions/:sessionId/bulletin/sth`（optional `auditorId` query）で設定し、現在の session を
  typed path builder で解決して API 内で直接 project する
- absolute HTTPS auditor URL は app と同じ origin でも external source として取得し、
  session credential header を送らない
- external response は documented canonical flat record だけを admission し、
  wrapper や `digest` / `root` / `log_id` alias を受理しない
- source 設定時は consensus threshold を満たさない failure が Verified を block する。未設定時は optional
- same-origin route は `{ data: { sth: { ... } }, meta }` を返す。transport failure、malformed
  evidence、unavailable evidence は API acquisition boundary が一度だけ分類し、pure verifier には
  admitted record と consensus result だけを渡す

## Bitmap proof（個票 explainability）

- `GET /api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex` は
  `leafChunk` + `auditPath` を返す
- `kind` は `included | seen` の required path value
- `included` は counted された index、`seen` は prover に提示された index
- bitmap は LSB-first で pack し、bit `i` は byte `i / 8` の bit position `i % 8`
- 通常の API usage では `i` を session の user vote index に限定する。隣接 slot や任意 index の inspection route はない
- proof source がある場合、現行 PoC の verification flow は proof を自動取得しうる。明示同意 gate はない
- client が `leafChunk` から bit を解釈する
- endpoint は succeeded authority と保存 sidecar を読み、root、`treeSize`、bitmap length を journal と照合してから proof を生成する。不在・不一致は fail closed にする
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

### Public `bundle.zip` manifest

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

この mode-aware manifest は default-deny です。sync builder は manifest-derived policy の
allowlist だけを収録し、required member を要求した上で completed ZIP を検査します。async
builder も同じ manifest を直接読み、未登録 member、required member の欠落、private member、
duplicate/case conflict、非 canonical path を含む completed ZIP を upload 前に拒否します。
配布時の reader admission は [Bundle/report delivery](#bundlereport-delivery) に従います。

`included-bitmap.json` と `seen-bitmap.json` は canonical bitmap-proof route の private
trusted source です。sync / async とも exact counted/presented bitmap を検証し、terminal success と
同じ commit で sidecar として保存します。AWS callback の retry 境界は
`public-book/src/aws/async-prover.md` を参照してください。

`bundle.zip` は、公開可能なファイルを使う bundle-only audit 用です。`/verify` UI の verdict を
再現するには、session-scoped bulletin proof、bitmap proof、設定時の third-party STH evidence
も必要です。private artifact は ZIP の外に保ちます。公開向けの
audit 手順は `public-book/src/reproducibility/index.md` を参照してください。

## Bundle/report delivery

- `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle` は `bundle.zip` を返す
- `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report` は protected `verification.json` の exact bytes を返す
- path の `finalizationId` は finalized authority の top-level `finalizationId` と一致しなければならない
- runtime composition は local または S3 reader を明示的に一つ選ぶ。unavailable/not-found を別 backend へ fallback させない
- local reader は complete `bundle.zip` を manifest-derived sync policy で再検査してから full/range bytes を返す
- S3 reader は ZIP を再 parse しない。publication 前に admission 済みの canonical object について、HEAD で固定した stable representation identity に bind された exact full/range bytes だけを返す
- `bundle.zip` は completed-archive admission 後に `Accept-Ranges: bytes` を返す。browser / CLI は byte-range response を結合し、4 MiB を超える bundle の range なし request は fail closed する
- `/artifacts/report` は small protected JSON を通常 body で返す。report が 4 MiB を超える場合は hosted payload limit を避けるため fail closed する
- browser / CLI は raw S3 URL や S3 redirect を public download contract として使わない

## 参考ドキュメント

- `docs/zkvm/final-design.md`
- `docs/ui/verify-page/verify-page.md`
- `docs/ui/api-contract.md`
- `docs/ui/knowledge-panel.md`
