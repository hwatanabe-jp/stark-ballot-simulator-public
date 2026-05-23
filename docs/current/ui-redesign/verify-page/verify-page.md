# 検証ページ (/verify) 方針

> この文書は、リデザイン意図を残しつつ、現行実装との整合を取った `/verify` 契約メモ。
> チェック ID と required/optional 判定の単一ソースは
> `src/lib/verification/verification-checks.ts`。

## 前提

- 検証への導線ボタンは **/result 側** に配置（「検証」ボタン）。
- `/verify` 到達時は、**通常は自動で検証シーケンスを開始**する（開始ボタンは不要）。
  - ただし、`/result` 経由の検証トリガーが無く、かつ STARK 状態も `not_run` のままな直接アクセスはブロックし、`/result` へ戻す導線を出す。
- サーバで成功した検証結果は **成功扱い** とする（実行主体はUIで明示しない）。
- **`/api/verify` が `verificationSteps` / `verificationChecks` を返す前提で UI はその結果を表示**する。
  - クライアント側で同等の重い検証は行わない。ローカル処理は主に Cast-as-Intended の補完と知識パネル反映に使う。
- `verificationChecks` は **22項目** が現行契約。
- `journal` 本体は `GET /api/verify?includeJournal=1` のときだけ返る。
  - 現行 handler は `includeJournal=1` で `journalStatus=available`、要求しない通常系で `journalStatus=omitted` を返す。
  - `journalStatus=unavailable` は forward-compatible な予約値として扱う。
- ResultSummary は **verificationChecks に加えて missing/invalid/excluded と STH 設定有無の文脈を参照**して要約を出す。
- **Never show Verified unless all required checks pass** が前提。
  - `excludedSlots > 0` は成功扱いにしない。
  - stale cache 等で legacy `excludedCount > 0` を受けた場合も fail-closed に倒す。
  - `recorded_consistency_proof`
  - `counted_missing_indices_zero`
  - `counted_expected_vs_tree_size`
  - `counted_election_manifest_consistent`
  - `counted_close_statement_consistent`
  - `stark_receipt_verify`
  - `recorded_sth_third_party` は STH source 設定時のみ blocking

## 画面構成（上から）

1. [Page Title + Subtitle] は必要
2. 主体は [UnifiedVerificationCard]
   - [Verification Steps]
   - [ResultSummary]（**一言の総合表現**に留める）
   - [Download CTA]
3. [Tabs: 私の検証 | ボット検証] は **S3 / S4 のときだけ表示**
   - 現行実装では「私の検証」タブのみ有効
   - ボット検証タブは disabled プレースホルダで、既存 bot verification panel をまだマウントしていない
4. ページ外側の状態表示
   - loading / session error / direct access error は page-level alert で表示
   - ステップ単位の operational error は Verification Steps Card 内でも表示されうる

## Verification Steps Card の詳細項目（細分化版）

- 従来の4カテゴリの中に、各小項目をリストしたような形にする（カテゴリ見出し＋小項目一覧）
- カテゴリ名は下記の4つ（Cast-as-Intended / Recorded-as-Cast / Counted-as-Recorded / STARK Verification）
- 検証ページに遷移した直後は、**まず STARK 状態の解決を待つ**。
  - `not_run` / `running` の間は内部で poll し、必要なら `/api/verification/run` を起動する。
- STARK 状態が解決した後、Verification Steps Card に「検証準備中」を **約2秒** 表示する。
- その後、カテゴリと小項目が **上から順に** 表示され、ステータスが順次更新される。
- 小項目には短いフェード/スライド系の状態変化を入れる。
- **API上の stage status** と **UIカード上の見た目のカテゴリ状態** は分けて考える。
  - `verificationSteps[].status` は、その stage で **required 扱いの checks** から導出する。
  - カード見出しの状態と `successCount/totalCount` は、表示中の小項目を UI 側で再集計する。
- `recorded_commitment_in_bulletin` と `recorded_root_at_cast_consistent` は、
  Inclusion / Consistency の **派生・補助表示** として独立行を保つ。
- STARK 依存項目は gate 付きで表示する。
  - STARK 成功前は `pending`
  - STARK 失敗時は対応する ZK 依存項目も fail 側に倒す
- 検証が完了したら、小項目クリックで **知識パネルに視覚フィードバック**を表示
  - 対応する知識キーを **枠線＋パルス**でハイライト（**2.5秒**でフェードアウト）
  - クリックごとに前回のハイライトは解除し、**最新の選択を優先**

### Cast-as-Intended（意図どおり投票されたか）

1. 受領データ最低限チェック（voteId / commitment の存在）
2. 選択肢レンジ検証（0..4 / A–E）
3. 乱数フォーマット検証（32-byte hex）
4. Commitment再計算一致（electionId + choice + random）

### Recorded-as-Cast（掲示板に正しく記録されたか）

5. 掲示板に commitment が存在
   - `recorded_inclusion_proof` 由来の補助表示。現行では optional / derived item として残す
6. bulletinIndex 範囲チェック
7. bulletinRootAtCast の整合
   - `recorded_consistency_proof` 由来の補助表示。現行では optional / derived item として残す
8. Inclusion proof 検証（CTスタイル / RFC 6962ベース）
9. Consistency proof 検証（split-view 対策）
10. STH 検証（第三者一致）
    - 設定されている場合のみ **blocking**（未設定時は optional 扱い）

### Counted-as-Recorded（記録された票が正しく集計されたか）

11. zkVM入力の妥当性（treeSize>0 / votes<=treeSize / root≠0）
12. 重複 index 排除
13. 重複 commitment 排除
14. tally 再計算一致
    - 公開 tally と zk 由来の verified tally の一致確認
    - 公開 `tally.counts` 単独では成功扱いにしない
15. **提示漏れ検知**（`missingSlots=0` を必須。check ID は `counted_missing_indices_zero`）
16. totalExpected と treeSize の一致要求（必須）
17. election manifest 整合
18. close statement 整合
19. **私の票の包含（bitmap proof）**
    - `/api/bitmap-proof?kind=included|seen` を使う explainability を含む
    - `seenBitmapRoot` があると、presented / invalid / not presented の切り分けが可能
20. inputCommitment 一致（index順の canonical binding）

> **Phase4.2 厳格モード補足**
>
> - `excludedSlots > 0` は **Counted-as-Recorded を failed 扱い**（missing + invalid の合算）
> - legacy `excludedCount` は現行 public response では返さず、互換入力としてだけ fail-closed に扱う
> - `counted_tally_consistent` は **zk 由来の tally evidence 前提**（`tally.counts` だけでは足りない）
> - `counted_expected_vs_tree_size` は **required hard failure**
> - `counted_election_manifest_consistent` は **required hard failure**
> - `counted_close_statement_consistent` は **required hard failure**

### STARK Verification（zkVM実行が正しいか）

21. receipt metadata の image_id 整合
22. STARK証明そのものの検証（receipt.verify）

## ResultSummary（要約ロジック）

- summary は `verificationChecks` を主入力とし、**missing/invalid/excluded の文脈**は別途参照する
- **必須チェック欠落は missing_evidence** に落とす（不完全なチェック列で Verified を出さない）
- STH は **設定時のみ required 扱い**で blocking
- `tally_consistency` が失敗し、証明/包含/完全性/入力整合が成功なら **公開結果不一致** として要約する
- 現行 summary status は以下を区別する
  - `fully_verified`
  - `in_progress`
  - `missing_evidence`
  - `verified_with_limitations`
  - `user_vote_excluded`
  - `votes_excluded`
  - `votes_excluded_unknown`
  - `recorded_integrity_failed`
  - `published_tally_mismatch`
  - `counted_integrity_failed`
  - `cast_integrity_failed`
  - `proof_verification_failed`
- **missing vs invalid** は sub message だけを分岐し、チェック自体は増やさない

## 削除/不要

- [FinalizationProgressCard] は不要
- [StatusCard: loading/error/info] は不要
- [SummaryCard] / [ResultSummary] / [DownloadCard] / [VerificationStepsCard] の旧分割構成は不要
  - 現行は [UnifiedVerificationCard] に統合

## エラー表示

- page-level の loading / session / direct-access error はカード外 alert で伝える
- step 実行中の operational error は **Verification Steps Card 内** でも伝える

## DownloadCard 方針

- UI上のリンク更新ボタンは不要
- download セクションは **sequenceComplete 後** に表示
- download は `sessionId` と `verificationExecutionId` から authenticated endpoint を組み立てる
- S3 URL の期限切れ時は `/api/verification/bundles/:sessionId/:executionId` または `/report` を再リクエストし、サーバ側で短命な配布 URL を再生成する
- local bundle fallback がある場合はそちらも候補に含める

## 補足

- 知識パネルとフッターは従来通り表示
- 現行 journal contract は `methodVersion=14` で、`seenBitmapRoot` を含む
