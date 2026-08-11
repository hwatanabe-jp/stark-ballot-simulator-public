# STARK Ballot Simulator 検証バンドル & 検証フロー（現行実装）

このドキュメントは **現行コードに基づく実装仕様** をまとめたものです。設計案や計画ではなく、
`apps/` / `packages/` / `infra/docker/` / `infra/terraform/` が示す挙動を唯一の真実とします。

## 実装の参照先

| 対象                             | 実装                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 検証ステップ/チェック生成        | `packages/verification/src/verification/build-verification-steps.ts`, `packages/verification/src/verification/build-verification-checks.ts`                                                                                                                                                                                                               |
| チェック定義                     | `packages/verification/src/verification/verification-checks.ts`                                                                                                                                                                                                                                                                                           |
| verification resource GET        | `apps/api/src/server/api/handlers/verify.ts`                                                                                                                                                                                                                                                                                                              |
| verification resource POST       | `apps/api/src/server/api/handlers/verificationRun.ts`                                                                                                                                                                                                                                                                                                     |
| verification observation POST    | `apps/api/src/server/api/handlers/verificationObservation.ts`                                                                                                                                                                                                                                                                                             |
| shared presentation policy       | `packages/verification/src/verification/verification-presentation-policy.ts`                                                                                                                                                                                                                                                                              |
| browser-local cast checks        | `packages/verification/src/verification/local-cast-checks.ts`                                                                                                                                                                                                                                                                                             |
| bundle/report 配布               | application artifact-reader port、Node/AWS adapters、`apps/api/src/server/api/handlers/verificationBundles.ts`                                                                                                                                                                                                                                            |
| public bundle manifest/admission | `packages/verification/src/verification/public-bundle-manifest.{json,ts}`、`verification-bundle.ts`                                                                                                                                                                                                                                                       |
| sync bundle 生成                 | `packages/verification/src/verification/verification-bundle.ts`                                                                                                                                                                                                                                                                                           |
| async bundle 生成                | `infra/docker/entrypoint.sh`                                                                                                                                                                                                                                                                                                                              |
| bitmap proof / sidecar admission | `packages/zkvm-contract/src/zkvm/bitmap-core.ts`、`packages/verification/src/merkle/bitmap-merkle-tree.ts`、`packages/application/src/finalize/{finalization-bitmap-admission,finalization-store}.ts`、`packages/aws-adapters/src/store/{dynamoSessionStore,fileMockSessionStore,mockSessionStore}.ts`、`apps/api/src/server/api/handlers/bitmapProof.ts` |
| STH                              | `apps/api/src/server/api/handlers/sth.ts`                                                                                                                                                                                                                                                                                                                 |

## 用語

- **receipt**: zkVM 実行の receipt artifact（`Receipt::verify(expectedImageId)` 対象）。`RISC0_DEV_MODE=1` の fake receipt は開発用 artifact であり、production STARK proof evidence ではない。Production STARK proof evidence として扱えるのは、dev-mode ではない verifier success のみ。
- **journal**: zkVM の公開出力（集計結果・整合性情報など）
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
Step Functions の状態と queue/progress estimate は `runtimeDiagnostics` にだけ置き、
finalization/proof authority にしません。

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

- `journal.value` が、`include=journal` で要求したときの canonical proof-bound payload です。canonical `journal` は `missingIndices` / `invalidIndices` / `countedIndices` / `excludedCount` を持ちません。
- `proofAuthority` の `verifiedTally`, `bulletinRoot`, `sthDigest`, `seenIndicesCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `treeSize`, `totalExpected` は admitted journal authority から project されます。
- `publicInputAuthority`, `electionManifest`, `closeStatement` は journal-derived cache ではありません。input-side authority、election-config-derived artifact、hybrid artifact として独立した整合性規則を持ち、handler は `counted_*` check の内部入力に使います。
- `presentation.tally`, `tamperDetected`, `tamperSummary`, `scenarioId` は presentation state であり、proof authority ではありません。
- `proofAuthority.imageId` は verifier 実行前の host-provided claim です。`journal.imageId` は comparison-only metadata であり、canonical proof output ではありません。verifier 実行後は full report の `receipt_image_id` が proved identity です。
- `missingSlots`: guest に提示されなかった bulletin slot 数
- `invalidPresentedSlots`: 提示された in-range slot のうち計上に失敗した slot 数
- `rejectedRecords`: 提示された record のうち検証で reject された record 数
- `excludedSlots`: slot-based の fail-closed signal。`> 0` なら全体検証は失敗する

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
idempotent に返します。

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

`stark_receipt_verify` は required check ですが、それだけで全体を Verified にすることはできません。

## `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`

この endpoint は verdict authority ではありません。画面で確定した
browser-local cast check と server authority を結合し、最終 verification summary を
CloudWatch 用に観測する endpoint です。

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
- `recorded_consistency_proof`, `counted_missing_indices_zero`, `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`, `counted_close_statement_consistent`, `counted_my_vote_included`, `counted_input_commitment_match`, `stark_image_id_match`, `stark_receipt_verify` は hard-failure signal
- `excludedSlots > 0` は成功を block する。`excludedCount` は current field ではなく exact admission で reject する。untyped な journal-like payload の defensive sanitization で存在を検出した場合も terminal success を `failed` へ落とすだけで、count authority や public contract として受理しない

`recorded_as_cast` / `counted_as_recorded` / `stark_verification` の step status は、その stage で
required となる check 群から server-side に導出します。`cast_as_intended` は GET verification resource では
`castSource='client'` のため server-side で `not_run` とし、verify page が browser 保存済みの
receipt/opening から local check を再計算します。`verification.steps[].inputs` は stage 内の全
check 定義から集約した UI highlight key です。

summary、stage status、fully-verified label eligibility、display precedence の単一 authority は
`packages/verification/src/verification/verification-presentation-policy.ts` です。browser-local
cast calculation は `local-cast-checks.ts` が所有し、web は local result を server checks に
overlay して同じ policy を再評価します。policy は checks と
`missingSlots/invalidPresentedSlots/rejectedRecords/excludedSlots` context を受け取り、次の規則を適用します。

- required check の欠落は `missing_evidence`
- STH は source 設定時だけ blocking
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
local artifact reader も sync policy で complete archive を再検査し、local delivery より前に
同じ条件を強制します。

`included-bitmap.json` と `seen-bitmap.json` は canonical bitmap-proof route の private
trusted source です。sync / async とも exact counted/presented bitmap を検証し、terminal success と
同じ commit で sidecar として保存します。AWS callback の retry 境界は
`public-book/src/aws/async-prover.md` を参照してください。

`bundle.zip` は bundle-only audit 用で、`/verify` UI の verdict を単体では完全再現しません。
UI verdict には session-scoped bulletin proof、bitmap proof、設定時の third-party STH evidence
も関わります。これは private artifact を漏らさないための意図的な PoC 境界です。公開向けの
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
