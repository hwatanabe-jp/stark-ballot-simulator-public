# 検証ページ (`/verify`) 契約

この文書は、現行 `/verify` 画面のデータ取得、表示順序、判定、観測、証拠配布の契約をまとめます。
画面と文書が異なる場合は、次の実装を優先します。

- check ID、category、evidence、base required/optional:
  `packages/verification/src/verification/verification-checks.ts`
- summary status と runtime requirement:
  `packages/verification/src/verification/verification-summary.ts`
- stage status、display eligibility、render readiness:
  `packages/verification/src/verification/verification-presentation-policy.ts`
- 画面制御: `apps/web/src/routes/verify/page.tsx`
- 4 category と22項目の表示: `apps/web/src/components/verification/UnifiedVerificationCard.tsx`
- request/response schema: `packages/api-contract/src/schemas/verification.ts`

非交渉の原則は **Never show Verified unless all required checks pass** です。required check の失敗、
未実行、実行中、欠落、または unknown check がある状態を `Verified` として表示してはいけません。

## 到達条件とデータライフサイクル

- 検証開始の導線は `/result` の「検証」ボタンです。
- `/verify` は path の exact `sessionId` / `finalizationId` と session capability を使って
  `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification` を実行し、strict response
  schema を通過した server-validated data だけを表示に使います。
- `/result` からの検証要求を示す session authority がなく、STARK status も `not_run` の直接アクセスは
  block します。画面は error alert と `/result` へ戻るボタンを表示します。
- 継続 authority がある場合、または STARK がすでに開始・完了している場合は、開始ボタンを出さずに
  verification sequence を自動開始します。
- verification resource の `verification.checks` は、重複や欠落のない22 checks の inventory と
  Recorded、Counted、STARK の結果の authority です。browser は exact inventory の admission 後、
  保存済みの receipt、choice、random を使って Cast-as-Intended の4 checks を再計算し、その4 status
  をすべて local result で置き換えます。重い検証を browser で再実装しません。
- verification 開始前は `user.voteReceipt` と `user.merklePath` を knowledge panel に公開しません。
  sequence 開始後、検証に使う evidence として反映します。

## Unified Verification Card と表示シーケンス

画面は title、subtitle、`UnifiedVerificationCard`、knowledge panel、footer で構成します。
`UnifiedVerificationCard` は Verification Steps、Result Summary、Download CTA を1つの card 内に
表示します。

S3 と S4 のときだけ「私の検証」「ボット検証」の tabs を表示します。現行では「私の検証」のみ有効で、
「ボット検証」は disabled placeholder です。

sequence は次の順で進みます。

1. STARK status が `not_run` の場合は同じ finalization-scoped verification resource へ `POST` を一度要求します。
2. STARK status が `not_run` または `running` の間は同じ resource を `GET` で poll し、terminal status
   (`success`、`failed`、`dev_mode`) または timeout を待ちます。
3. card は項目表示前に「検証準備中」を表示します。STARK 解決後も通常は約2秒表示を続けます。
4. Cast-as-Intended、Recorded-as-Cast、Counted-as-Recorded、STARK Verification を上から順に
   表示し、各 category の status を順次確定します。
5. sequence 完了後、Result Summary と Download CTA を表示します。pending または running の
   check が残る間は最終 summary を表示しません。

server resource の `verification.steps[].status` は server checks から導出されます。browser は
Cast overlay 後の checks に shared presentation policy を再適用し、runtime 上 required となる checks
から表示用の `verificationSteps[].status`、最終 verdict、表示 eligibility を導出します。一方、card の
category header status と `successCount/totalCount` は、optional を含むその category の表示項目すべてを
card 内で集計します。この表示集計を最終 verdict の判定に使いません。

ZK evidence に依存する項目は STARK gate を適用します。すでに `failed` の項目は gate が `pending`
でも失敗を維持し、それ以外は STARK 成功前に `pending` とします。STARK gate が失敗した場合は、
失敗していなかった依存項目も `failed` として表示します。category と項目には短い slide/fade
transition を使います。

sequence 完了後、knowledge key を持つ小項目を click すると、対応する knowledge panel 項目を
枠線と pulse で highlight します。前回の highlight を解除して最新の click を優先し、2.5秒後に
解除します。

UI copy は `apps/web/src/i18n/translations/en.ts` と `ja.ts` で同期します。test や page object は
翻訳文字列ではなく、次の stable `data-testid` を使います。

- category: `step-${categoryId}`
- check: `check-${checkId}`
- summary container: `result-summary`
- overall status: `overall-status`

## 22 checks の表示契約

verification resource の `verification.checks` は次の22項目です。`recorded_commitment_in_bulletin` と
`recorded_root_at_cast_consistent` は、required proof の結果から導出する optional な補助表示です。

### Cast-as-Intended

1. `cast_receipt_present` — voteId / commitment の存在
2. `cast_choice_range` — choice が A–E の範囲
3. `cast_random_format` — random が 32-byte hex
4. `cast_commitment_match` — electionId + choice + random からの commitment 再計算一致

### Recorded-as-Cast

5. `recorded_commitment_in_bulletin` — bulletin 上の commitment（optional、inclusion proof から導出）
6. `recorded_index_in_range` — bulletinIndex の範囲
7. `recorded_root_at_cast_consistent` — bulletinRootAtCast の整合
   （optional、consistency proof から導出）
8. `recorded_inclusion_proof` — CT / RFC 6962-style inclusion proof
9. `recorded_consistency_proof` — append-only consistency proof
10. `recorded_sth_third_party` — third-party STH consensus

### Counted-as-Recorded

11. `counted_input_sanity` — treeSize、vote count、root の基本条件
12. `counted_unique_indices` — index の重複排除
13. `counted_unique_commitments` — commitment の重複排除
14. `counted_tally_consistent` — published tally と zkVM journal の verified tally の一致
15. `counted_missing_indices_zero` — missing / invalid slot がないこと
16. `counted_expected_vs_tree_size` — totalExpected と treeSize の一致
17. `counted_election_manifest_consistent` — election manifest と session authority の一致
18. `counted_close_statement_consistent` — close statement と finalized STH authority の一致
19. `counted_my_vote_included` — included / seen bitmap proof による user vote の説明
20. `counted_input_commitment_match` — index 順 canonical input の commitment 一致

`counted_my_vote_included` は
`/api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex` の authenticated
evidence を使います。API acquisition boundary が store から strict に project した
`included` / `seen` proof だけを pure verification engine に渡します。
`seenBitmapRoot` がある場合は、user index を `presented and counted`、`presented but invalid`、
`not presented to the prover` に分けて説明できます。

### STARK Verification

21. `stark_image_id_match` — expected ImageID、receipt、journal の authority 一致
22. `stark_receipt_verify` — `Receipt::verify(expectedImageId)` に相当する proof verification

## Required、optional、blocking

base optional は次の3 checks です。

- `recorded_commitment_in_bulletin`
- `recorded_root_at_cast_consistent`
- `recorded_sth_third_party`

それ以外は base required です。`recorded_sth_third_party` は STH source が設定されている場合に
effectively required となり、設定された consensus threshold を満たさなければ blocking です。

すべての required check の失敗は fully verified を block します。特に次の checks は
hard-failure signal です。

- `recorded_consistency_proof`
- `counted_missing_indices_zero`
- `counted_expected_vs_tree_size`
- `counted_election_manifest_consistent`
- `counted_close_statement_consistent`
- `counted_my_vote_included`
- `counted_input_commitment_match`
- `stark_image_id_match`
- `stark_receipt_verify`

`stark_receipt_verify` は required ですが、単独で `Verified` にする十分条件ではありません。
`excludedSlots > 0`、treeSize の不一致、または ImageID の不一致は成功を block します。

## Result Summary と verdict

summary semantics は `deriveVerificationSummary()`、stage と最終表示 eligibility の authority は
`deriveVerificationPresentationPolicy()` です。22 checks に加えて、
`missingSlots`、`invalidPresentedSlots`、`rejectedRecords`、`excludedSlots`、STH source 設定、
dev-mode evidence を context として使います。

- required check の欠落、`not_run`、unknown check は `missing_evidence`
- required check の `pending` / `running` は `in_progress`
- optional check だけが `failed` / `not_run` なら `verified_with_limitations`
- completeness failure は user inclusion result と組み合わせて `user_vote_excluded`、
  `votes_excluded`、`votes_excluded_unknown` を区別
- `counted_tally_consistent` だけが失敗し、proof、inclusion、completeness、input integrity、
  Recorded checks が成功していれば `published_tally_mismatch`
- dev-mode receipt または demo evidence を含む成功は `demo_only`。production `Verified` として
  表示しない
- proof、Recorded、Counted、Cast の required failure は対応する failure summary にする

現行 status は次の集合です。

```text
fully_verified
demo_only
in_progress
missing_evidence
verified_with_limitations
user_vote_excluded
votes_excluded
votes_excluded_unknown
recorded_integrity_failed
published_tally_mismatch
counted_integrity_failed
cast_integrity_failed
proof_verification_failed
```

missing と invalid の違いは summary の sub message と bitmap note で説明し、check ID を増やしません。

## Verdict に影響しない最終観測

sequence 完了後、browser は次の条件をすべて満たすときだけ
`POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations` を
best-effort で実行します。

- exact finalization-scoped response が server validation 済み
- STARK status が `success`、`failed`、`dev_mode` のいずれか
- sequence が完了し、`pending` / `running` check がない
- current `finalizationId` と Cast-as-Intended の4 status が揃っている

request は path identity と session capability で認証し、body には次の4 status
(`success | failed | not_run`) だけを含めます。`finalizationId` は body に重複させません。

- `cast_receipt_present`
- `cast_choice_range`
- `cast_random_format`
- `cast_commitment_match`

同じ session、finalization、4 status の fingerprint は in-flight と送信済みを重複送信しません。
deterministic な 4xx は terminal とし、`408`、`425`、`429`、network failure、5xx は dependency
state が変わった場合だけ再試行対象になりえます。

この observation は browser-local Cast result と server authority を結合した運用観測用です。
送信成功、失敗、未送信のいずれも画面の verdict、summary、check status を変更しません。
server-side の保存、idempotency、event emission contract は `docs/ui/api-contract.md` と
`docs/verification/README.md` を参照してください。

## Error と direct access

- initial loading、session missing / replaced、direct access block は card 外の page-level alert で表示
- direct access block では `/result` へ戻る操作を提供
- STARK poll timeout は verification failure として summary に反映
- step 実行中の operational error は該当 category 内に一般化した message で表示可能
- unsupported / corrupt finalized artifact や capability loss は fail closed とし、stale finalized
  projection をそのまま表示しない

## Bundle と protected report

Download CTA は `sequenceComplete` 後だけ表示します。候補は current `sessionId` と
`finalizationId` から組み立てた authenticated endpoint に限定します。

- bundle:
  `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`
- protected report:
  `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`

raw S3 URL、S3 redirect、presigned URL、任意の cross-origin URL を UI contract にしません。
`bundle.zip` が byte-range response を返す場合、browser は認証付き range request を
順番に結合して zip を保存します。report は range を使わず認証付き JSON body として取得します。
Download CTA は bundle を保存し、report candidate がある場合は同じ操作で protected report も
取得します。

## Journal と legacy exclusion

通常の `/verify` 画面は finalization-scoped verification `GET` を journal 本体なしで呼び出します。
同じ resource に `?include=journal` を指定した response contract は次のとおりです。

- requested: `journal.representation=included` と `journal.value`
- not requested: `journal.representation=omitted`、`value` なし

現行 journal は `methodVersion=14` で、`seenBitmapRoot` を必須 field として含みます。
current exclusion authority は `missingSlots`、`invalidPresentedSlots`、`rejectedRecords`、
`excludedSlots` です。public response に legacy `excludedCount`、`missingIndices`、
`invalidIndices`、`countedIndices` を戻しません。

canonical journal が clean な場合、stale top-level の legacy count aliases は authority として
採用せず無視します。一方、journal-shaped payload 内に legacy count alias が1つでも存在すれば、
値が0でも current journal として受理せず fail closed にします。
