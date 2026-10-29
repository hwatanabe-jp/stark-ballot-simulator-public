# 検証ページ (`/verify`) 契約

この文書は、現行 `/verify` 画面のデータ取得、表示順序、判定、観測、証拠配布の契約をまとめます。
画面と文書が異なる場合は、次の実装を優先します。

- check ID、category、evidence、base required/optional:
  `packages/verification/src/verification/verification-checks.ts`
- summary status と runtime requirement:
  `packages/verification/src/verification/verification-summary.ts`
- stage status、display eligibility、render readiness:
  `packages/verification/src/verification/verification-presentation-policy.ts`
- 画面構成: `apps/web/src/routes/verify/page.tsx`
- session identity と取得・開始・invalidation の制御:
  `apps/web/src/routes/verify/hooks/useVerificationSession.ts`、`useVerificationController.ts`
- resource admission、Cast overlay、検証 sequence:
  `apps/web/src/routes/verify/hooks/useVerificationData.ts`、`useVerificationSequence.ts`、
  `apps/web/src/routes/verify/lib/local-cast-evidence.ts`
- shared policy から画面表示への変換: `apps/web/src/routes/verify/lib/verification-presentation.ts`
- download、最終観測、tamper message:
  `apps/web/src/routes/verify/hooks/useVerificationArtifacts.ts`、`useVerificationObservation.ts`、
  `useVerificationTamperError.ts`
- 4 category と22項目の表示: `apps/web/src/components/verification/UnifiedVerificationCard.tsx`
- request/response schema: `packages/api-contract/src/schemas/verification.ts`

非交渉の原則は **Never show Verified unless all required checks pass** です。required check の失敗、
未実行、実行中、欠落、または unknown check がある状態を `Verified` として表示してはいけません。

## 到達条件とデータライフサイクル

- 検証開始の導線は `/result` の「検証」ボタンです。
- `/verify` 自体は session / finalization の path parameter を持ちません。browser session identity の
  `sessionId` と canonical finalized snapshot の `finalizationId` を API request path に入れ、
  session capability とともに
  `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification` を実行します。strict response
  schema と取得対象の `finalizationId` の一致を確認した data だけを表示に使います。schema は
  canonical checks の順序・metadata と steps、公開 evidence から再評価できる check status、
  report / journal / tally / voter evidence / scenario / policy の相互整合を検証します。
  不整合や未知の形は `corrupt` とし、成功表示へ project しません。数値境界を含む詳細は
  [API 契約](../api-contract.md) と [検証フロー](../../verification/README.md) を参照してください。
- `/result` からの検証要求を示す session authority がなく、STARK status も `not_run` の直接アクセスは
  block します。画面は error alert と `/result` へ戻るボタンを表示します。
- 継続 authority がある場合、または STARK がすでに開始・完了している場合は、開始ボタンを出さずに
  verification sequence を自動開始します。
- verification resource の `verification.checks` は、重複や欠落のない22 checks の inventory と
  Recorded、Counted、STARK の結果の authority です。server の Cast-as-Intended 4 checks は
  `not_run` です。browser は resource の admission 後、`voterEvidence` から得た receipt と
  browser session に保存済みの election ID、choice、random を使ってその4 checks を再計算し、
  すべて local result で置き換えます。STARK receipt の検証は server が担当します。
- verification 開始前は `user.voteReceipt` と `user.merklePath` を knowledge panel に公開しません。
  sequence 開始後、STARK の実待機が解決してから、取得した evidence を同じ session の knowledge
  として反映します。待機中に session が無効になった場合は公開しません。

## Unified Verification Card と表示シーケンス

画面は title、subtitle、`UnifiedVerificationCard`、knowledge panel、footer で構成します。
route が title、subtitle、card を組み立て、knowledge panel と footer は共通の
`apps/web/src/components/LayoutProvider.tsx` が配置します。
`UnifiedVerificationCard` は先頭に Result Summary と Download CTA を配置し、その下に4 category の
Verification Steps を表示します。小項目は番号、label、evidence、status の対応が読み取れる行で
揃えます。

S3 と S4 のときだけ「私の検証」「ボット検証」の tabs を表示します。「私の検証」が有効で、
「ボット検証」は disabled placeholder です。

sequence は次の順で進みます。

1. STARK status が `not_run` の場合は同じ finalization-scoped verification resource へ `POST` を一度要求します。
2. STARK status が `not_run` または `running` の間は同じ resource を `GET` で poll し、terminal status
   (`success`、`failed`、`dev_mode`) または timeout を待ちます。
3. 実待機中は card に「検証準備中」を表示します。見た目のための固定待機時間は加えません。
4. 解決した payload から Cast-as-Intended、Recorded-as-Cast、Counted-as-Recorded、
   STARK Verification の status を求め、4 category と sequence 完了を一括反映します。
   category ごとの疑似的な running 表示や段階表示の遅延は加えません。
5. sequence 完了後、card 先頭に Result Summary と Download CTA を表示します。pending または
   running の check が残る間は最終 summary を表示しません。画面離脱や verification authority の
   invalidation が発生した実行は、stale な evidence の公開や sequence 完了へ進みません。

server resource の `verification.steps[].status` は server checks から導出され、wire policy の
stage status との一致も admission で確認します。browser は wire policy を表示 authority として
引き継がず、Cast overlay 後の checks に shared presentation policy を再適用します。runtime 上
required となる checks から表示用の `verificationSteps[].status`、最終 verdict、表示 eligibility を
導出し、画面の開始・完了状態も使って render readiness を判定します。一方、card の
category header status と `successCount/totalCount` は、optional を含むその category の表示項目すべてを
card 内で集計します。この表示集計を最終 verdict の判定に使いません。

ZK evidence に依存する項目は STARK gate を適用します。すでに `failed` の項目は gate が `pending`
でも失敗を維持し、それ以外は STARK 成功前に `pending` とします。STARK gate が失敗した場合は、
失敗していなかった依存項目も `failed` として表示します。category と項目は slide、fade、flash を
伴わず表示します。

sequence 完了後、対応する既存 knowledge 値が実在し、route の表示許可にも含まれる小項目を
選択すると、同じ値をその行の直下に表示します。選択は別の項目を選ぶか同じ項目を再び選んで
解除するまで持続します。時間経過による解除や knowledge panel の自動 pulse は使いません。
表示対象は実在する許可済みの値だけで、空欄や未取得の evidence を補って表示しません。

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
- `stark_receipt_verify`

`counted_my_vote_included`、`counted_input_commitment_match`、`stark_image_id_match` も required で、
失敗は fully verified を block します。`stark_image_id_match` と `stark_receipt_verify` の失敗は
explicit proof failure としても判定します。

`stark_receipt_verify` は required ですが、単独で `Verified` にする十分条件ではありません。
`excludedSlots > 0`、treeSize の不一致、または ImageID の不一致は成功を block します。

## Result Summary と verdict

summary semantics は `deriveVerificationSummary()`、stage と最終表示 eligibility の authority は
`deriveVerificationPresentationPolicy()` です。22 checks に加えて、
`missingSlots`、`invalidPresentedSlots`、`rejectedRecords`、`excludedSlots`、STH source 設定、
dev-mode evidence を context として使います。

`VerifiedPresentation` は shared policy 内の非公開 witness を持つ branch です。required checks
の成功、hard failure と明示的な server failure の不在、`fully_verified` summary、全4 stage の
成功、non-demo evidence、`ready` な verified display が揃ったときだけ policy が生成します。
wire 上の成功 field や boolean をコピーしてこの branch を構築することはできません。web は
再導出した policy の `fullyVerifiedLabelEligible` が true の場合だけ `Verified` を表示します。

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
- STARK poll timeout は STARK step の失敗と明示的な verification failure として扱います。
  summary は display readiness が `ready` の場合に表示し、取得済み checks に `pending` / `running`
  が残る間は最終 summary を表示しません。
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

## Journal と exclusion authority

通常の `/verify` 画面は finalization-scoped verification `GET` を journal 本体なしで呼び出します。
同じ resource に `?include=journal` を指定した response contract は次のとおりです。

- requested: `journal.representation=included` と `journal.value`
- not requested: `journal.representation=omitted`、`value` なし

現行 journal は `methodVersion=14` で、`seenBitmapRoot` を必須 field として含みます。
current exclusion authority は `missingSlots`、`invalidPresentedSlots`、`rejectedRecords`、
`excludedSlots` です。public resource と included journal は exact schema で admission し、
legacy `excludedCount`、`missingIndices`、`invalidIndices`、`countedIndices` などの未登録 field は
値が0でも拒否します。canonical journal があっても top-level alias を無視して受理する経路は
ありません。included journal と `proofAuthority` の重複する事実も照合し、不整合を補正せず
fail closed にします。
