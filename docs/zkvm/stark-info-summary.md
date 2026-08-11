# STARK証明検証で得られる情報の現行整理

## 証明 authority と Verified 判定

現行実装の zkVM guest は、提示された入力を検証して集計し、個別の
`choice` / `random` を含まない集計結果と整合性メタデータを Journal に出力します。
guest は教育用の S0–S5 シナリオ自体を知りません。正しい Journal と照合する
claimed tally、`scenarioId`、`tamperDetected`、`tamperSummary` は presentation state であり、
proof authority ではありません。`tamperDetected` は `excludedSlots`、`rejectedRecords`、
scenario metadata からサーバ側で導出します。

現行の count は次の意味で分離されています。

- `missingSlots`: bulletin にあるが guest に提示されなかった slot 数
- `invalidPresentedSlots`: guest に提示された in-range slot のうち、最終的に計上されなかった slot 数
- `rejectedRecords`: duplicate や out-of-range を含む、検証で reject された record 数
- `excludedSlots`: slot-based の除外数で、`missingSlots + invalidPresentedSlots` と一致する

`missingIndices` / `invalidIndices` / `countedIndices` / `excludedCount` は廃止済みです。
現行 Journal の admission はこれらを reject し、現行 field への正規化、fallback、
互換 reader は提供しません。untyped な journal-like payload に廃止 field が残っている場合も、
その payload を current journal として受理せず fail-closed に扱います。

UI が `Verified` を表示できるのは、shared presentation policy が
`fullyVerifiedLabelEligible = true` と判定したときだけです。少なくとも次の条件を
すべて満たす必要があります。

1. required check がすべて存在し、`success` である
2. `missingSlots` / `invalidPresentedSlots` / `excludedSlots` がすべて 0 で、その関係も整合する
3. cast 時点の exact CT evidence、counted/seen bitmap proof、必要な public audit artifact が整合する
4. ImageID 照合と `Receipt::verify(expectedImageId)` が成功する
5. 証拠が production proof であり、development/fake receipt ではない

development 許可 path が fake receipt を検出できても、その結果は `demo_only` であり、
production STARK proof や `Verified` 表示の根拠にはなりません。required check が欠落、
`not_run`、`pending`、`running`、`failed` の場合や、verification resource が unavailable/corrupt の
場合も `Verified` にはなりません。

### cast 時点の exact evidence と browser-local opening

「あなたの票が bulletin に記録された」ことは、最終 Journal だけでは確認できません。
現行フローは次の exact cast-time evidence を照合します。

- `voteReceipt.bulletinRootAtCast`
- `userVote.proof` または
  `GET /api/sessions/:sessionId/votes/:voteId/inclusion-proof` の RFC 6962 inclusion proof
- store に保存された `rootAtCast`

proof は cast 時点の `treeSize = leafIndex + 1` に対するもので、proof から得た root と
保存済み `rootAtCast` が一致しなければなりません。不一致または再構成不能の場合、
finalize / verification read / inclusion-proof flow は fail-closed に扱います。

cast-as-intended の `choice` / `random` / commitment 照合は browser がローカルに保持する opening から
再計算します。server へ送る最終 observation は 4 つの browser-local check status だけで、
`choice`、`random`、commitment、receipt そのものは observation body に含めません。

## Journal と証拠の公開境界

Journal はバイナリの proof output です。パース後の canonical proof-bound field は次の形です。

```json
{
  "electionId": "...",
  "electionConfigHash": "0x...",
  "bulletinRoot": "0x...",
  "treeSize": 64,
  "totalExpected": 64,
  "sthDigest": "0x...",
  "verifiedTally": [14, 13, 13, 12, 12],
  "totalVotes": 64,
  "validVotes": 64,
  "invalidVotes": 0,
  "seenIndicesCount": 64,
  "missingSlots": 0,
  "invalidPresentedSlots": 0,
  "rejectedRecords": 0,
  "seenBitmapRoot": "0x...",
  "includedBitmapRoot": "0x...",
  "excludedSlots": 0,
  "inputCommitment": "0x...",
  "methodVersion": 14
}
```

host-decoded output や application が扱う `journal.json` には、optional な `imageId` が付く場合が
あります。これは比較用の host metadata であり、canonical proof output ではありません。
proof identity は verifier report の `receipt_image_id` と expected ImageID の照合で最終確認します。

証拠の公開境界は次のとおりです。

| 境界                       | 含まれる情報                                                                   | 含まれない情報                                                          |
| -------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Journal                    | 集計結果、count、`bulletinRoot`、`sthDigest`、`inputCommitment`、bitmap root   | `choice`、`random`、voter identity、`tamperDetected`、scenario metadata |
| `public-input.json`        | vote ごとの `index`、`commitment`、`merklePath` と公開 input metadata          | `choice`、`random`                                                      |
| public `bundle.zip`        | 下記の mode-aware manifest で許可された監査資料                                | private witness、full verifier report、exact bitmap artifact            |
| protected/private artifact | `input.json`、`verification.json`、`included-bitmap.json`、`seen-bitmap.json`  | public bundle には収録しない                                            |
| session-scoped response    | exact `voteReceipt`、`userVote.proof`、許可された個票の inclusion/bitmap proof | public bundle への無認証公開はしない                                    |
| browser local              | user の `choice` / `random` opening、receipt                                   | server-side proof artifact や public bundle としては扱わない            |

public bundle の exact member は次のとおりです。

- sync: `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`,
  `journal.json`, `metadata.json`（optional: `sth.json`, `consistency-proof.json`）
- async: `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`,
  `journal.json`
- never public: `input.json`, `verification.json`, `included-bitmap.json`, `seen-bitmap.json`

この manifest は default-deny です。未登録 member、required member の欠落、private member、
duplicate/case conflict、非 canonical path を含む archive は公開より前に reject します。

`public-input.json` により、どの bulletin index が prover に提示されたかは監査できます。
その index が counted されたかは、Journal の `includedBitmapRoot` と session-scoped な
bitmap proof で別途確認します。そのため public bundle 単体は bundle-only audit の資料であり、
session-scoped proof、browser-local opening、設定時の third-party STH evidence まで含む UI verdict を
完全に再現するものではありません。

## シナリオ別の検出（S0–S5）

S0–S5 はすべて教育用シミュレーションです。S2/S4 は proof input ではなく claimed tally を
変更し、S1/S3/S5 は vote を guest input から除く input tamper として扱います。
どのシナリオも public artifact に `choice` / `random` を公開しません。

### S0: 正常な投票

- `verifiedTally` と claimed tally が一致する
- `missingSlots` / `invalidPresentedSlots` / `rejectedRecords` / `excludedSlots` は 0
- scenario 由来の不一致がないため `tamperDetected = false`

### S1: あなたの票の除外

- user の commitment は bulletin に記録済みだが、その vote を guest input から除く
- original bulletin index を保ったまま sparse input を作るため、`missingSlots` と `excludedSlots` が増える
- exact cast-time inclusion proof は成功し、`counted_my_vote_included` と bitmap proof が
  「記録済みだが counted されていない」ことを示す
- `counted_missing_indices_zero` と `counted_my_vote_included` が失敗し、overall verification は失敗する

### S2: 発表結果改ざん・あなた

- original vote を zkVM input に渡すため、Journal / receipt / verifier は正しい `verifiedTally` を支持する
- presentation の claimed tally だけを変更し、`counted_tally_consistent` の失敗から
  `published_tally_mismatch` として検出する
- public bundle だけでは再集計先を個票に紐づけられない。session-scoped presentation には
  `tamperSummary.userRecountedTo` が出る場合がある

### S3: ボット票の除外

- core/server シナリオは対象の bot vote 1 票を guest input から除く
- original bulletin index を保つ sparse input のため `missingSlots` と `excludedSlots` が増え、
  `validVotes` と `totalExpected` の間に欠落が出る
- `counted_missing_indices_zero` が失敗し、overall verification は失敗する
- public bundle から除外の発生は分かるが、対象票の `choice` は分からない

### S4: 発表結果改ざん・ボット

- original bot vote を zkVM input に渡し、presentation の claimed tally だけを変更する
- `verifiedTally` と claimed tally の不一致を `published_tally_mismatch` として検出する
- public 情報からは個票の再集計先ではなく tally mismatch として観測される

### S5: ランダムエラー注入

- core/server シナリオはランダムに選んだ 1 票を guest input から除く
- browser-mock の current fixture は、デモ用に `missingSlots = 4`,
  `invalidPresentedSlots = 0`, `excludedSlots = 4` をモデル化する
- どちらも欠落した bulletin slot を表す `missingSlots` が主信号であり、
  presented in-range slot の検証失敗を表す `invalidPresentedSlots` とは区別する
- S2/S4 の claimed-tally tamper とは異なり、overall verification は exclusion として失敗する
