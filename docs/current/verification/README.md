# STARK Ballot Simulator 検証バンドル & 検証フロー（現行実装）

このドキュメントは **現行コードに基づく実装仕様** をまとめたものです。設計案や計画ではなく、
`src/` / `docker/` / `amplify/` が示す挙動を唯一の真実とします。

## 参照ポイント（実装の出典）

- 検証ステップ/チェック生成: `src/lib/verification/build-verification-steps.ts`, `src/lib/verification/build-verification-checks.ts`
- チェックIDの単一ソース: `src/lib/verification/verification-checks.ts`
- `/api/verify` 実装: `src/server/api/handlers/verify.ts`
- バンドル生成（同期）: `src/lib/verification/verification-bundle.ts`
- バンドル生成（非同期）: `docker/entrypoint.sh`
- `/api/verification/run` 実装: `src/server/api/handlers/verificationRun.ts`
- `/api/verification/bundles/*` 実装: `src/server/api/handlers/verificationBundles.ts`
- `/api/bitmap-proof` 実装: `src/server/api/handlers/bitmapProof.ts`
- `/api/sth` 実装: `src/server/api/handlers/sth.ts`

## 用語

- **receipt**: zkVM 実行の STARK 証明（`Receipt::verify(expectedImageId)` 対象）
- **journal**: zkVM の公開出力（集計結果・整合性情報など）
- **input**: zkVM 入力（witness を含む。公開禁止）
- **public-input**: input から witness を除いた公開入力
- **verification.json**: verifier-service の検証結果（公開禁止）
- **bundle.zip**: 公開用の証拠パッケージ
- **executionId**: finalize 実行単位の識別子

## フロー概要（現行）

1. `POST /api/session` セッション作成
2. `POST /api/vote` 投票（ユーザー + Bot 投票）
3. `POST /api/finalize` zkVM 実行 → bundle 生成・保存
4. `GET /api/verify` 検証情報取得（検証ステップ/チェック含む）
5. `POST /api/verification/run` サーバ側で STARK 検証（必要時）

補助エンドポイント:

- verification-support: `GET /api/bulletin/:voteId/proof`（その session の本人票、または S3/S4 で `affectedBotIds` に含まれる Bot 票のみ）
- inspection/debug: `GET /api/bulletin`
- secondary tooling / building blocks: `GET /api/bulletin/consistency-proof`, `GET /api/botdata/:id`
- `GET /api/bitmap-proof?i=`（個別票の bitmap 証明）
- `GET /api/sth`（第三者 STH 取得用）

## Session-scoped auth

- `POST /api/session` は `sessionId` と `capabilityToken` を返します。
- 次の **session-scoped** endpoint は capability token が必須です。
  - `POST /api/vote`
  - `GET /api/progress`
  - `POST /api/finalize`
  - `POST /api/finalize/cancel`
  - `GET /api/verify`
  - `POST /api/verification/run`
  - `GET /api/bulletin`
  - `GET /api/bulletin/:voteId/proof`
  - `GET /api/bulletin/consistency-proof`
  - `GET /api/botdata/:id`
  - `GET /api/bitmap-proof`
  - `GET /api/sth`
  - `GET /api/zkvm-input-hash`
  - `GET /api/sessions/:id/status`
  - `GET /api/verification/bundles/*`
- ヘッダー形式:

```http
X-Session-ID: <sessionId>
X-Session-Capability: <capabilityToken>
```

- `POST /api/vote` / `GET /api/progress` / `POST /api/finalize` / `POST /api/finalize/cancel` / `GET /api/verify` / `POST /api/verification/run` / `GET /api/bulletin` / `GET /api/bulletin/:voteId/proof` / `GET /api/bulletin/consistency-proof` / `GET /api/botdata/:id` / `GET /api/bitmap-proof` / `GET /api/sth` は `X-Session-ID` と `X-Session-Capability` の両方を使って session を解決します。
- `/api/sessions/:id/status` と `GET /api/verification/bundles/*` は path の sessionId を使って session scope を確定し、`X-Session-Capability` を検証します。現行 handler ではこれらの endpoint で `X-Session-ID` は必須ではありません。
- `GET /api/zkvm-input-hash?sessionId=...` は query の `sessionId` で session scope を確定し、`X-Session-Capability` を検証します。現行 handler では `X-Session-ID` は必須ではありません。
- `GET /api/bulletin/:voteId/proof` は session capability に加えて対象 `voteId` の ownership 制約があります。現行実装では、その session の user vote か、S3/S4 の `tamperSummary.affectedBotIds` に対応する Bot vote だけを返し、それ以外は `VOTE_NOT_FOUND` で fail-closed します。
- STH の third-party 照合では、same-origin の `/api/sth` にだけ session auth headers を転送します。外部 STH source には capability token を送信しません。

## `/api/verify` 契約（現行）

### Query

- `includeJournal=1`: `journal` を含める。現行 handler では `journalStatus=available`
- 省略時: `journal` を含めず `journalStatus=omitted`
- `refreshS3=1`: 現行 handler はこの query parameter を見ず、raw S3 URL の再発行もしない

`includeBulletin` は存在しません。Bulletin 取得は `/api/bulletin`（inspection）または `/api/bulletin/:voteId/proof`（session-authorized な個票 proof）を使用します。

### 主要レスポンス項目

- 識別系: `electionId`, `electionConfigHash`, `logId`
- シナリオ/表示系: `scenarioId`, `imageId`, `tamperDetected`, `tamperSummary`
- 集計: `tally { counts, totalVotes, tamperedCount }`, `verifiedTally`
- 公開パラメータ: `bulletinRoot`, `treeSize`, `totalExpected`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `seenIndicesCount`
- count mirror: `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`
- ユーザー票: `voteReceipt`, `userVote`
- 検証状態: `verificationStatus`, `verificationReport`
- 実行識別: `verificationExecutionId`
- 検証UI用: `verificationSteps`, `verificationChecks`
- `journalStatus`: 現行 handler では `omitted | available`

`voteReceipt` と `userVote.proof` は、store から exact cast-time CT artifact を再構成できた場合にだけ含まれます。現行 `/api/verify` は exact proof が取得できなくても `200` を維持し、その場合はこれらの field を省略したまま recorded inclusion/consistency 系チェックを fail-closed に `not_run` / `missing_evidence` 側へ倒します。

`/api/verify` は `publicInputArtifact` 由来の `publicInputAuthority`, `electionManifest`, `closeStatement`, `scenarios`, `s3BundleKey` を top-level response としては返しません。これらは server-side の検証入力、bundle artifact、または内部 metadata として使われます。

browser / CLI の現行 download selector authority は `verificationExecutionId` です。consumer は
session context + `verificationExecutionId` から
`/api/verification/bundles/:sessionId/:executionId` を locally derive して使用します。
current-generation の finalized authority では、安全な top-level
`verificationExecutionId` が必須です。missing / unsafe な値は
`corrupt_or_unreadable` として fail-closed し、consumer は
`verificationResult.executionId` へ fallback しません。
`verificationBundleUrl` / `verificationReportUrl` / `s3BundleUrl` / `refreshS3` は
現行 `/api/verify` の public contract には含まれません。

`verificationSteps` / `verificationChecks` は常に生成されます。ID の定義は
`src/lib/verification/verification-checks.ts` が単一ソースです。

- `recorded_as_cast` / `counted_as_recorded` / `stark_verification` の `verificationSteps[].status` は、その stage で required 扱いになるチェック群から server-side に導出されます
- `cast_as_intended` は現行 `/api/verify` では `castSource='client'` のため server-side では `not_run` を返し、verify page 側がブラウザ保存済みの receipt/opening から local check を再計算して上書きします
- `verificationSteps[].inputs` は、stage 内の全チェック定義から集約した UI 用 highlight key です

### authority と count semantics

- `journal` が canonical な proof-bound payload です。canonical `journal` は `missingIndices` / `invalidIndices` / `countedIndices` / `excludedCount` を持ちません。`verifiedTally`, `bulletinRoot`, `sthDigest`, `seenIndicesCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `treeSize`, `totalExpected` など、top-level に残っている重複項目は **互換維持用の派生/cache field** であり、`journal` と一致していなければなりません。
- `publicInputArtifact` から導出した `publicInputAuthority`, `electionManifest`, `closeStatement` は **journal-derived cache ではありません**。それぞれ input-side authority / election-config-derived artifact / hybrid artifact として独立した整合性ルールを持ち、現行 `/api/verify` handler はそれらを内部入力として `counted_*` チェック評価に使いますが、top-level response には露出しません。
- `tally`, `tamperDetected`, `tamperSummary`, `scenarioId`, `verification*` は presentation / control 用の top-level state であり、proof-derived cache ではありません。
- top-level `imageId` は verifier 実行前の **host-provided claim** です。`journal.imageId` は comparison-only metadata であり canonical proof output ではありません。verifier 実行後は `verificationReport.receipt_image_id` を proved identity として扱います。
- 現行 count field の意味は次の通りです。
- `missingSlots`: guest に提示されなかった bulletin slot 数。**slot ベース**です。
- `invalidPresentedSlots`: guest に提示された in-range slot のうち、計上に失敗した件数。**slot ベース**です。
- `rejectedRecords`: guest に提示された record のうち、検証で reject された件数。**record ベース**です。
- `excludedSlots`: fail-closed のための **slot ベースの失敗シグナル** です。`> 0` なら全体検証は失敗します。
- legacy `missingIndices` / `invalidIndices` / `countedIndices` / `excludedCount` は現行 `/api/verify` の public response から retired されています。loose boundary や stale local cache の互換入力として受ける場合は、canonical `journal` / current slot fields へ畳み込むだけで、current public contract としては再公開しません。
- 個票レベルの explainability は `seenBitmapRoot` / `includedBitmapRoot` と private bitmap artifact を使って行います。現在の count field だけで各 index の状態を完全に説明する設計ではありません。

### fail-closed 応答

`/api/verify` は、supported current finalized authority を復元できるケースでは `200` を返します。
一方、`unsupported_current_artifact` と `corrupt_or_unreadable` は fail-closed の
JSON payload を返し、現行実装では `200` + `error` + `message` + `artifactState`
の shape で fail-closed します。

`400` は auth / capability / precondition failure や truly exceptional な内部失敗に限りません。
例えば `SESSION_NOT_FINALIZED` や `USER_NOT_VOTED` も `400` 系です。現行の fail-closed finalized
artifact contract は `verify.ts` / `verificationRun.ts` / `sessionStatus.ts` / bundle download routes
の route tests を source of truth とします。

## 検証ステージとチェック

ステージ:

- Cast-as-Intended
- Recorded-as-Cast
- Counted-as-Recorded
- STARK Verification

チェック ID は `src/lib/verification/verification-checks.ts` を唯一の真実とし、
ドキュメント内のリストは参照用です。

```text
Cast:    cast_receipt_present, cast_choice_range, cast_random_format, cast_commitment_match
Recorded: recorded_commitment_in_bulletin, recorded_index_in_range, recorded_root_at_cast_consistent,
         recorded_inclusion_proof, recorded_consistency_proof, recorded_sth_third_party
Counted: counted_input_sanity, counted_unique_indices, counted_unique_commitments, counted_tally_consistent,
         counted_missing_indices_zero, counted_expected_vs_tree_size, counted_election_manifest_consistent,
         counted_close_statement_consistent, counted_my_vote_included, counted_input_commitment_match
STARK:   stark_image_id_match, stark_receipt_verify
```

- blocking required checks の網羅は `verification-checks.ts` の `criticality: 'required'` です。現行では Cast 4 checks、`recorded_index_in_range`, `recorded_inclusion_proof`, `recorded_consistency_proof`,
  Counted 10 checks（`counted_input_sanity` から `counted_input_commitment_match` までの required checks）、
  `stark_image_id_match`, `stark_receipt_verify` が required です。
- `recorded_sth_third_party` は通常 optional ですが、STH sources が設定されている場合は required 扱いで blocking になります。
- 特に `recorded_consistency_proof`, `counted_missing_indices_zero`, `counted_expected_vs_tree_size`,
  `counted_election_manifest_consistent`, `counted_close_statement_consistent`, `counted_my_vote_included`,
  `counted_input_commitment_match`, `stark_image_id_match`, `stark_receipt_verify` は、失敗時に `Verified` を出してはいけない hard-failure signals です。

## STH（第三者照合）

- 設定は `NEXT_PUBLIC_STH_SOURCES` と `NEXT_PUBLIC_STH_MIN_MATCHES`
- 相対URL（`/api/sth`）は検証時のリクエスト origin に対して解決
- same-origin の `/api/sth` は `X-Session-ID` / `X-Session-Capability` 付きで取得される
- cross-origin の STH source には session capability を送らない
- **設定されている場合のみ** 失敗や合意不足は「Verified」をブロック（未設定時は optional 扱い）

`/api/sth` は `sth-verifier` が読む形式で `{ sth: { ... } }` を返します。

## Bitmap proof（個別票の explainability）

- `GET /api/bitmap-proof?i=&kind=included|seen` で `leafChunk` + `auditPath` を返却
- `kind` 省略時は `included`
- `included` は「counted された index」、`seen` は「prover に提示された index」を表す
- bitmap は LSB-first で pack され、bit `i` は byte `i / 8` の bit position `i % 8` に対応する
- `X-Session-ID` と `X-Session-Capability` を用いて保存済み private bitmap artifact を取得
- 現行 PoC では、proof source がある場合に検証フローから自動取得されうる。明示同意ゲートは実装していない
- 取得した `leafChunk` から bit の解釈はクライアント側で実施
- 保存された bitmap の root が journal と一致しない場合は proof を無効化
- `seenBitmapRoot` がある場合、`counted_my_vote_included` は `included` と `seen` を組み合わせて次を説明できる
- `presented and counted`
- `presented but invalid`
- `not presented to the prover`
- 24h cache（`immutable`）

## Proof bundle（現行契約）

### 生成物（bundle ディレクトリ）

- `input.json`（private / witness）
- `public-input.json`（public）
- `election-manifest.json`（public）
- `close-statement.json`（public）
- `journal.json`, `receipt.json`
- `metadata.json`（sync のみ）
- `verification.json`（private）
- `included-bitmap.json`（private / exact counted bitmap artifact）
- `seen-bitmap.json`（private / exact presented bitmap artifact）

### 公開 bundle（sync）

```text
public-input.json, election-manifest.json, close-statement.json, receipt.json, journal.json, metadata.json
(+ optional) sth.json, consistency-proof.json
```

### 公開 bundle（async）

```text
public-input.json, election-manifest.json, close-statement.json, receipt.json, journal.json
```

`bundle.zip` は public artifact の bundle-only audit を支える配布対象アーカイブであり、`/verify` UI の最終判定を単体で完全再現するものではありません。UI verdict には session-scoped な bulletin proof、bitmap proof、設定時の third-party STH evidence も関わります。この差分は private artifact を漏らさないための意図的な PoC 境界です。公開向けの監査手順は `public-book/src/reproducibility/index.md` を参照してください。

### 非公開（絶対に公開しない）

```text
input.json, verification.json, included-bitmap.json, seen-bitmap.json
```

- `included-bitmap.json` は `/api/bitmap-proof` の trusted source 用 private artifact
- `seen-bitmap.json` は per-index explainability 用 private artifact
- sync / async ともに finalization 時点の exact counted/presented bitmap を保存し、public `bundle.zip` には含めない

## バンドル配布

- `GET /api/verification/bundles/:sessionId/:executionId` → `bundle.zip`
- `GET /api/verification/bundles/:sessionId/:executionId/report` → `verification.json`
- authoritative な `s3BundleKey` / `s3ReportKey` があり、かつ S3 配布が有効な場合だけ 302 で S3 にリダイレクトする
- authoritative な S3 key がない場合は、この authenticated route がローカル保存済み artifact を直接返す
- browser / CLI は raw S3 URL ではなく、この authenticated route を public download contract として使う

## STARK 検証

- `POST /api/verification/run` は、authoritative な `s3BundleKey` がある場合は `verifier-service-runner` 経由で、ない場合は trusted local bundle を直接 `verifier-service` に渡して `Receipt::verify(expectedImageId)` を実行する
- 結果は `verification.json` に保存され、`/api/verify` で参照可能

## 検証結果サマリー

- 生成元: `src/lib/verification/verification-summary.ts`
- 入力: `verificationChecks` に加えて `missingSlots/invalidPresentedSlots/rejectedRecords/excludedSlots` の文脈。legacy mirror は `/api/verify` の boundary で canonical field に畳み込まれ、summary logic には渡しません
- 方針:
  - **必須チェック欠落は missing_evidence**
  - **STH は設定時のみ required 扱いで blocking**
  - **missing vs invalid は文言だけ分岐**（チェック数は増やさない）
  - **`counted_tally_consistent`（role: `tally_consistency`）が失敗**し、証明/包含/完全性/入力整合が成功の場合は `published_tally_mismatch`

## 参考ドキュメント

- `docs/current/guides/6-zkvm_design/final_design.md`
- `docs/current/ui-redesign/verify-page/verify-page.md`
- `docs/current/ui-redesign/api-contract.md`
- `docs/current/ui-redesign/knowledge-panel.md`
