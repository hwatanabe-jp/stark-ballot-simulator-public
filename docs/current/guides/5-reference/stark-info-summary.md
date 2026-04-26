# STARK証明検証で得られる情報の現行整理

## 現行仕様の要点

現行実装では、zkVM は個別の投票内容そのものを公開せずに、**正しい集計結果と整合性メタデータ** を Journal と公開監査資料へ出力します。一方で、検証体験は Journal 単独では成立せず、**cast 時点の厳密な CT inclusion proof** と fail-closed なチェック評価も前提になります。

### 基本原則

1. **zkVM は改ざんシナリオを知らない**: guest/journal は正しい集計と整合性情報のみを出力する
2. **choice/random は公開しない**: witness を含む `input.json` は private artifact であり、Journal や public bundle には出ない
3. **検出は複数の信号で行う**: claimed tally と `verifiedTally` の差分だけでなく、`missingSlots` / `invalidPresentedSlots` / `excludedSlots` / bitmap proof / verifier result を組み合わせる
4. **`tamperDetected` は Journal の値ではない**: 現行では `excludedSlots`、`rejectedRecords`、scenario metadata などからサーバ側で導出する。legacy `excludedCount` は stale payload を fail-closed に倒す互換入力であり、現行 public contract では返さない
5. **Verified 判定は fail-closed**: exact cast-time evidence が欠ける、required check が未実行/失敗、`excludedSlots > 0`、または proof verification が失敗した場合は、UI は `Verified` を出してはいけない

> **注意**: S2/S4 は教育用シミュレーションです。zkVM input / Journal / receipt は正しい集計のままで、UI の claimed tally との不一致を検出します。

## 現行 Journal の公開情報

Journal はバイナリですが、パース後の現行 public shape は概ね次の通りです。

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
  "methodVersion": 12,
  "imageId": "0x..."
}
```

`imageId` は比較用の host metadata であり、Journal の canonical proof output そのものではありません。proof identity の最終確認は verifier result 側で行います。

### 公開される情報

- 集計結果: `verifiedTally`
- 整合性カウンタ: `totalVotes`, `validVotes`, `invalidVotes`, `seenIndicesCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`
- 検証メタデータ: `bulletinRoot`, `sthDigest`, `inputCommitment`, `seenBitmapRoot`, `includedBitmapRoot`
- public bundle に含まれる監査資料: `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`, `journal.json`

### 公開されない情報

- 個々の投票内容そのもの: `choice`, `random`
- 投票者と投票内容の対応
- witness を含む `input.json`
- verifier output の `verification.json`
- private bitmap artifact: `included-bitmap.json`, `seen-bitmap.json`

## exact cast-time 証跡について

現行実装では、「あなたの票が bulletin に記録された」と言うために、単に最終 Journal を見るだけでは不十分です。次の情報が **exact cast-time evidence** として扱われます。

- `voteReceipt.bulletinRootAtCast`
- `userVote.proof` または `GET /api/bulletin/:voteId/proof` で得られる RFC 6962 inclusion proof
- store に保存された `rootAtCast`

これらは、cast 時点の `treeSize = leafIndex + 1` に対する proof と、保存済み `rootAtCast` が一致してはじめて有効です。一致しない場合や再構成できない場合、現行の finalize / verify / bulletin proof flow は fail-closed で扱います。

## public bundle と private artifact

### Public bundle に入るもの

- sync: `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`, `journal.json`, `metadata.json`（optional: `sth.json`, `consistency-proof.json`）
- async: `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`, `journal.json`

### Public bundle に入れないもの

- `input.json`
- `verification.json`
- `included-bitmap.json`
- `seen-bitmap.json`

> **補足**: `public-input.json` には zkVM input に提示された vote の `index` / `commitment` / `merklePath` が入ります。したがって「どの bulletin index が prover に提示されたか」は公開監査資料から分かりますが、それが counted されたかは `includedBitmapRoot` と bitmap proof で別途確認します。choice/random は依然として公開されません。

## シナリオ別の検出（S0-S5）

以下は教育用シナリオの見え方の要約です。いずれも個々の vote の choice/random は露出しません。

### 1. 正常な投票（S0）

- `verifiedTally` と claimed tally が一致
- `missingSlots` / `invalidPresentedSlots` / `excludedSlots` が 0
- `rejectedRecords` も 0
- `tamperDetected = false`

### 2. あなたの票の除外（S1）

**状況**: あなたのコミットメントは記録されるが、zkVM input から除外される。  
**検出**:

1. exact cast-time inclusion proof は成功する
2. `missingSlots` または `invalidPresentedSlots` が増え、結果として `excludedSlots > 0` になる
3. `counted_my_vote_included` と bitmap proof により、「記録済みだが counted されていない」ことを示せる
4. fail-closed により overall verification は成功しない

### 3. 発表結果改ざん・あなた（S2）

**状況**: claimed tally が改ざんされ、あなたの票が別候補へ移されたように見える。  
**検出**:

1. `verifiedTally` は正しい集計のまま
2. claimed tally と `verifiedTally` の不一致から `published_tally_mismatch` を検出する
3. proof-derived / public bundle だけでは、個票の露出はなく、再集計先も統計的にしか分からない（session-scoped response では `tamperSummary.userRecountedTo` が出る場合がある）

### 4. ボット票の除外（S3）

**状況**: 1 体以上のボット票が zkVM input から除外される。  
**検出**:

- `missingSlots` / `invalidPresentedSlots` / `excludedSlots` が増える
- `validVotes` と `totalExpected` の間に欠落が出る
- `counted_missing_indices_zero` が失敗し、overall verification は fail-closed になる
- 誰かの票が除外されたことは分かるが、公開 bundle だけでは個票の choice は分からない

### 5. 発表結果改ざん・ボット（S4）

**状況**: claimed tally が改ざんされ、ボット票が付け替えられたように見える。  
**検出**:

- `verifiedTally` と claimed tally の差分
- Journal / receipt / verifier は正しい集計側を支持する
- 個票特定ではなく、公開情報からは tally mismatch として観測される

### 6. ランダムエラー注入（S5）

**状況**: ランダムに 1 票を選び、現行実装では input tamper として除外または choice 書換えを適用する。  
**検出**:

- 除外分岐では `missingSlots` / `invalidPresentedSlots` / `excludedSlots` の増加が主信号になる
- choice 書換え分岐では、提示された slot が集計に失敗し `invalidPresentedSlots` / `rejectedRecords` / `excludedSlots` の増加が主信号になる
- S5 は S2/S4 のような純粋な claimed tally tamper ではなく、modified input を guest に渡す教育用 input tamper として扱う
- 実装上は `rejectedRecords` だけが増えて `tamperDetected=true` になるケースもありうる

## セキュリティとプライバシー

### 保護される情報

1. **すべての個別投票内容**
   - 改ざんの有無に関わらず、choice/random は public artifact に出ない

2. **投票者と投票内容の対応**
   - 誰がどこに投票したかは公開 bundle からは分からない

3. **改ざんの詳細そのもの**
   - proof-derived な公開情報だけでは、choice/random や voter identity に紐づく詳細は特定できない

### 露出する情報

1. **集約結果と整合性メタデータ**
   - Journal には `verifiedTally`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`, `inputCommitment`, bitmap root 群などが出る
   - public bundle には `public-input.json`, `election-manifest.json`, `close-statement.json` などの監査資料が入る

2. **zkVM input の index / commitment / path**
   - `public-input.json` には vote ごとの `index` / `commitment` / `merklePath` が入る
   - counted 済みかどうかは `includedBitmapRoot` と bitmap proof で確認する
   - ただし choice/random や voter identity は含まれない

3. **session-scoped な exact proof**
   - `voteReceipt` や `userVote.proof`、`/api/bulletin/:voteId/proof` は public bundle ではなく session-scoped response として扱われる
   - 現行実装では exact cast-time proof を再構成できない場合、この情報は fail-closed になる

## まとめ

現行の STARK 検証フローでは、**個票のプライバシーを保持しつつ、改ざんや欠落を fail-closed に検出する** ことを重視しています。

- 発表結果の改ざん（S2/S4）は、正しい Journal と claimed tally の不一致として検出する
- 票の除外（S1/S3）は、`excludedSlots` と user inclusion 系チェックで検出する
- `tamperDetected` は Journal の値ではなく、`excludedSlots` だけでなく `rejectedRecords` 等も含めて導出される
- exact cast-time CT evidence や required check が欠ける場合、UI は `Verified` を出さない
