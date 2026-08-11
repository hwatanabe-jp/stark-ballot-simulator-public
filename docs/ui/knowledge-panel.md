# 知識パネル仕様（CURRENT / 実装準拠）

> 最終更新: 2026-08-09
> 主な実装 authority: `apps/web/src/knowledge/{types,normalizer,store,visibility}.ts`、
> `apps/web/src/session/{client,storage,storageAdmission}.ts`、
> `apps/web/src/finalize/client-finalization-result.ts`、
> `apps/web/src/routes/{HomePage,vote,aggregate,result,verify}`、
> `apps/web/src/components/{LayoutProvider,knowledge/*}`、
> `packages/verification/src/verification/verification-checks.ts`

本書は、現在のブラウザ内 knowledge snapshot、その入力境界、表示規則、ルートごとの更新ライフサイクルを説明する。実装と本書が異なる場合は、上記の current code と隣接テストを正とする。

---

## 1. 目的と現在の公開範囲

- 知識パネルは、現在のブラウザセッションについて「ユーザーが知り得る情報のスナップショット」を表示する。
- snapshot はクライアントの `localStorage` にだけ保存する。サーバー側に knowledge store を同期しない。
- 接続済みの公開フローは「自分の投票」の knowledge を表示する。ボット投票の進捗表示はあるが、個々の bot opening を取得・検証する公開フローは接続されていない。
- UI は単一カラムで、デスクトップでは浮遊/ドッキングパネル、モバイルではボトムシートとして表示する。
- `/` と `/privacy` / `/terms` 系では知識パネルを表示しない。

---

## 2. Snapshot の保存、所有権、admission

### 2.1 保存 API

- 保存キーは `localStorage` の `stark-ballot-knowledge`。
- API/route projection からの取り込みは `mergeKnowledgeFromApi()`、すでに knowledge shape になった値の追加は `saveKnowledgeData()` を使う。
- `mergeKnowledgeFromApi()` は入力を正規化し、`omitKeys` を適用した後、`saveKnowledgeData()` の admission を通す。
- `undefined` の patch 値は既存値を削除せず無視する。値が実際に変化したキーだけを新規/更新項目として通知する。

### 2.2 セッション所有権と複数タブ

- knowledge write は、明示された `sessionId`、`expectedSessionId`、または active session に束縛される。
- 既存 snapshot と異なる新しい `sessionId` を受け入れる場合、以前の knowledge を引き継がず、新しい `sessionId` を基点に作り直す。
- `expectedSessionId` が active session と一致しない場合や、別タブが session を置き換えて現在の tab lock が stale になった場合、read/write は knowledge を返さず、置換後の共有 snapshot を変更しない。
- active session があるのに snapshot に `sessionId` がない場合は、その snapshot を削除する。snapshot の `sessionId` が active session と異なる場合は表示しないが、別セッション所有の共有 snapshot は削除しない。
- 保存済み session 自体が current session shape に適合しない場合、session admission が session、knowledge、tab lock をまとめて破棄する。

### 2.3 Read/write の fail-closed validation

- storage schema version marker や read-time migration は使わない。保存済み snapshot は、現在の `KnowledgeData` のキーと値 shape にそのまま適合する場合だけ読み込む。
- malformed JSON、未知キー、retired key、`null`、または不正な current key value を含む、現在の tab が所有する snapshot は、部分修復せず snapshot 全体を拒否して削除する。
- `missingIndices`、`invalidIndices`、`countedIndices`、`excludedCount`、`s3BundleUrl`、`s3BundleExpiresAt`、`proofMode` はすべて current key ではない。保存済みデータから個別削除して再利用することはない。
- write は既存値と patch を合わせた candidate 全体を検証してから永続化する。candidate が不正なら、patch 全体を拒否し、storage、item timestamp、listener を更新しない。
- `mergeKnowledgeFromApi()` の未知の入力フィールドは normalizer が無視する。一方、正規化後の current key に不正な値がある場合は candidate write 全体が失敗する。

主な value admission は次のとおり。

- count/index/timestamp は非負の safe integer。
- `tally.counts` は `A`〜`E` の完全な exact-key object で、各値は非負の safe integer。
- choice、scenario、bundle status、verification step ID/status は現在の closed vocabulary のみ。
- inclusion proof は `leafIndex`、`treeSize`、`merklePath`、`bulletinRootAtCast` だけを持つ canonical RFC 6962 proof。index/tree の範囲と 32-byte hex node/root も検証する。
- verification step、vote receipt、receipt publication、verification report summary は、後述の current exact shape だけを受け入れる。

### 2.4 明示的なクリア

- `/` へ遷移した時点。
- Header の「やり直す」実行時。
- `/result` の「最初からやり直す」実行時。
- session の期限切れ、または current session admission の失敗時。

---

## 3. Resource projection と knowledge normalization

### 3.1 二段階の境界

API resource と knowledge store の shape は同一ではない。取り込みは次の順序で行う。

1. route-specific projection が API resource を検証し、ブラウザ用の current payload に投影する。
   - succeeded finalization resource は `projectFinalizationResourceToClientSnapshot()` / `resolveCanonicalFinalizationPayload()` により `ClientFinalizationSnapshot` になる。
   - available verification resource は `projectVerificationResource()` により flat な `VerificationPayload` になる。ここで `verification.steps`、`verifierResult.report`、`journal.representation = "included"` の `journal.value` を、それぞれ `verificationSteps`、`verificationReport`、raw `journal` に投影する。
2. `normalizeKnowledgeData()` が projected payload の正規フィールドを knowledge key に写し、`saveKnowledgeData()` が candidate 全体を admission する。

`normalizeKnowledgeData()` 自体は、nested API resource envelope の parser ではない。raw finalization/verification resource を projection せず直接渡すことは current route contract ではない。

### 3.2 正規化するフィールド

- top-level vote response:
  - `vote` → `user.choice`
  - `rand` → `user.random`
  - `commitment` → `user.commitment`
  - `voteId` → `user.voteId`
  - `bulletinIndex` → `user.bulletinIndex`
  - `bulletinRootAtCast` → `user.bulletinRootAtCast`
  - `castAtMs` → `user.castAtMs`
- `userVote.vote` / `commitment` / `random` / `voteId` → 対応する `user.*` key。
- `userVote.proof` または top-level `proof` → canonical `user.merklePath`。
- `tally` → `tally.counts` / `tally.totalVotes` / `tally.tamperedCount`。
- projected `verificationSteps` → `verification.steps`。
- projected `verificationReport` → `verification.reportSummary`。
- supported raw `journal` → `bulletinRoot`、`treeSize`、`totalExpected`、`missingSlots`、`invalidPresentedSlots`、`rejectedRecords`、`validVotes`、`excludedSlots`、`sthDigest`、`seenBitmapRoot`、`includedBitmapRoot`、`inputCommitment`。

旧名や alias は変換しない。たとえば `merkleRoot`、`tally.merkleRoot`、`rootAtTime`、`zkVMInputCommitment`、`proofMode` は current knowledge にならない。proof object に `proofMode` が含まれる場合も canonical proof として受け入れない。

supported `journal` と stale な top-level copy が同時にある場合、journal-derived な公開証跡と完全性メトリクスを優先する。

### 3.3 Stored structured values

`user.voteReceipt` は入力 object をそのまま保存しない。normalizer は canonical source fields を選び、source の `castAtMs` を stored `timestamp` に変換する。検証シーケンスから直接保存する場合も、同じ stored shape を作る。

```ts
interface VoteReceipt {
  voteId: string;
  commitment: string;
  bulletinIndex: number;
  bulletinRootAtCast: string;
  timestamp: number;
  inputCommitment?: string;
}
```

`verification.reportSummary` は verifier report 全体ではなく、knowledge に必要な次の投影だけを保存する。`verifier_version`、`verified_at`、ImageID、`dev_mode_receipt` は保持しない。

```ts
interface VerificationReportSummary {
  status: string;
  duration_ms?: number;
  errors?: string[];
}
```

`receiptPublication` は次の exact shape。`timestamp` は保存できるが、パネルの要約表示には使わない。

```ts
interface ReceiptPublication {
  receiptHash: string; // 32-byte hex
  boardIndex: number;
  timestamp?: number;
}
```

`verification.steps` / `bot.verification.steps` の各要素は `id`、`status`、`inputs` を必須とし、`error` だけを optional field として認める。

---

## 4. Knowledge key と現在の surface

### 4.1 接続済み surface と dormant bot scaffolding

接続済みの公開フローでは、session、user vote、result/public evidence、user verification evidence を保存・表示する。`botVotesStatus` は投票フェーズのボット投票生成進捗であり、個々の bot opening ではない。

型、group、filter には `bot.*` と `VERIFY_BOT_KNOWLEDGE_KEYS` が残っており、generic `KnowledgePanel` は有効な bot-scoped item が与えられれば表示できる。`clearBotKnowledge()` も bot-scoped key を削除できる。一方、current public API payload を `bot.*` に正規化する関数や専用 merge API はなく、`/verify` に bot opening の取得・Bot modal・bot verification sequence は接続されていない。S3/S4 で表示する bot tab は disabled で、通常の public route は `my` view のまま動作する。

### 4.2 表示グループと順序

| 順序 | group   | keys                                                                                                                                                                                                                                                                                                       |
| ---: | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | session | `electionId`, `electionConfigHash`, `logId`                                                                                                                                                                                                                                                                |
|    2 | vote    | `user.choice`, `user.random`, `user.commitment`, `user.voteId`, `user.bulletinIndex`, `user.bulletinRootAtCast`, `botVotesStatus`                                                                                                                                                                          |
|    3 | result  | `proofBundleStatus`                                                                                                                                                                                                                                                                                        |
|    4 | verify  | `user.voteReceipt`, `user.merklePath`                                                                                                                                                                                                                                                                      |
|    5 | bot     | `bot.id`, `bot.choice`, `bot.random`, `bot.commitment`, `bot.voteId`, `bot.bulletinIndex`, `bot.bulletinRootAtCast`, `bot.voteTimestamp`, `bot.merklePath`, `bot.verification.steps`                                                                                                                       |
|    6 | public  | `tally.counts`, `tally.totalVotes`, `tally.tamperedCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `validVotes`, `excludedSlots`, `totalExpected`, `bulletinRoot`, `treeSize`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `imageId`, `receiptPublication` |

public group は常に最後に置く。`missingSlots` / `invalidPresentedSlots` / `validVotes` / `excludedSlots` は slot-based metric、`rejectedRecords` は record-based metric である。`tally.tamperedCount` は表示用の除外数で、通常は journal の `excludedSlots` を反映し、シナリオ由来の改ざん件数があればその count も反映しうる。

次の key は snapshot に保持するが、全 route の知識パネルで非表示にする。

- `sessionId`
- `user.castAtMs`
- `scenarioId`
- `verification.steps`
- `verification.reportSummary`

---

## 5. レイアウトと表示規則

### 5.1 ルート別 filter

| route                                | 表示対象                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `/`                                  | 非表示                                                                                    |
| `/vote`                              | session + vote                                                                            |
| `/aggregate`                         | session + vote                                                                            |
| `/result`                            | session + vote + result + public                                                          |
| `/verify` とその subpath             | `VERIFY_MY_KNOWLEDGE_KEYS`。dormant bot view の filter 定義は `VERIFY_BOT_KNOWLEDGE_KEYS` |
| `/privacy` / `/terms` とその subpath | 非表示                                                                                    |
| その他                               | 全 group                                                                                  |

`VERIFY_MY_KNOWLEDGE_KEYS` は `electionId`、user choice/random/commitment/voteId、verification-gated な user receipt/proof、public group 全体、`proofBundleStatus` で構成する。

### 5.2 Responsive variant

- Desktop: `variant="floating"`
  - 通常は画面下部に固定し、dock zone が視界に入ると本文フローへ合流する。
  - 浮遊中はパネル高さと下端 offset に対応する spacer を確保する。
  - 浮遊中の最大高さは 30vh。超過分は内部スクロールにし、scroll position をドッキング切替後も復元する。
  - 浮遊→ドッキングでは expanded group を引き継ぐ。ドッキング中の変更は floating state へ同期しないため、ドッキング→浮遊でリセットされうる。
- Mobile: `variant="bottomSheet"`
  - `collapsed`: 60px
  - `mid`: 40vh
  - `expanded`: 80vh
- `inline` variant は generic component として残るが、`LayoutProvider` は使用しない。

### 5.3 展開、新規表示、ハイライト

- 初期状態は全 group を折りたたみ、自動展開や自動スクロールは行わない。
- 「展開 / 縮小」で現在表示対象の全 group を操作する。
- admitted write で値が変わった key は 2 秒間 `isNew=true` になり、group header の animation/緑 dot と、展開済み item の緑 dot を表示する。
- `/verify` では進行中 step の入力 key を highlight する。filter 済みかつ表示中の item だけが見える。

### 5.4 値フォーマット

- label は `knowledge.items.*` の i18n を使い、未定義なら raw key を表示する。
- hash は `0xaaaa…bbbb` 形式に省略し、クリックでコピーできる。
- number は `toLocaleString()`、boolean は「はい/いいえ」、generic object は field 数で要約する。
- `proofBundleStatus`: 未ダウンロード / ダウンロード済。
- `botVotesStatus`: pending/completed と、存在すれば total。
- `tally.counts`: `A:1 B:2 ...`。
- `user.merklePath` / `bot.merklePath`: `idx:<leafIndex> / <treeSize>`。
- `user.voteReceipt`: `#<bulletinIndex>`。
- admitted `receiptPublication` は必須の `receiptHash` を hash 表示する。generic renderer は外部から渡された item 向けに `#<boardIndex>` fallback も持つ。
- generic renderer は `null` / `undefined` に「未設定 / Not set」を返すが、admitted stored snapshot はその値を保持しない。

---

## 6. Route lifecycle

### 6.1 Session と vote

1. `/` で `POST /api/sessions` が成功すると、session identity を初期化し、`mergeKnowledgeFromApi('session', ...)` で `sessionId`、`electionId`、`electionConfigHash`、`logId` を保存する。`sessionId` は表示しない。
2. `/vote` の選択時に `user.choice` を保存する。
3. `POST /api/sessions/:sessionId/votes` 成功時に `user.random`、`user.commitment`、`user.voteId`、`user.bulletinIndex`、`user.bulletinRootAtCast`、`user.castAtMs` を保存する。
4. ボット投票生成中は `botVotesStatus` を pending、完了時は completed と total に更新する。

### 6.2 Finalization から result

1. `/aggregate` のシナリオ選択は非表示 key `scenarioId` に保存する。
2. `POST /api/sessions/:sessionId/finalizations` の sync succeeded resource、または `GET /api/sessions/:sessionId/finalizations/current` の async succeeded resource を `ClientFinalizationSnapshot` に投影する。unsupported/stale payload を再解釈しない。
3. snapshot を browser session の `finalizeResult` に保存し、knowledge へ投影する。この時点では `VERIFICATION_GATED_KEYS` (`user.voteReceipt`, `user.merklePath`) を除外する。
4. `/result` は current finalization resource を再取得・投影して session snapshot と knowledge を更新する。journal-derived completeness metrics を current value で保存し、`proofBundleStatus` が未設定なら `not_downloaded` にする。すでに `downloaded` なら維持する。

### 6.3 Verification gating と authenticated artifact delivery

1. `/verify` は current session に canonical `finalizeResult` があることを要求し、その `finalizationId` で finalization-scoped verification resource を取得する。
2. response admission と `projectVerificationResource()` が成功した available resource だけを `VerificationPayload` として扱う。knowledge merge では引き続き `user.voteReceipt` / `user.merklePath` を除外する。
3. server-validated data がそろうと verification sequence を自動開始する。ただし STARK status が `not_run` の場合は continuation authority も必要とし、direct access だけでは開始しない。STARK status の解決後、sequence 開始境界で canonical `user.voteReceipt` / `user.merklePath` を同じ expected session に保存し、初めてパネル表示を許可する。
4. bundle/report candidate は、safe な current `sessionId` と payload 自身の `finalizationId` から authenticated endpoint を組み立てる。nested identity、署名 URL、保存済み S3 URL への fallback はない。
5. bundle candidate がある場合は未設定の `proofBundleStatus` を `not_downloaded` にする。authenticated bundle download が成功した場合だけ `downloaded` に更新する。URL や expiry は knowledge に保存しない。

---

## 7. 検証 step の highlight authority

既定の highlight input は `packages/verification/src/verification/verification-checks.ts` の check definition から `getVerificationStepInputs()` が導出する。projected API step に non-empty `inputs` があればそれを優先する。

- `cast_as_intended`: `electionId`, `user.choice`, `user.random`, `user.commitment`, `user.voteId`
- `recorded_as_cast`: `user.commitment`, `user.voteReceipt`, `user.merklePath`, `treeSize`, `bulletinRoot`, `sthDigest`
- `counted_as_recorded`: `proofBundleStatus`, `bulletinRoot`, `treeSize`, `tally.counts`, `tally.totalVotes`, `missingSlots`, `invalidPresentedSlots`, `totalExpected`, `electionId`, `electionConfigHash`, `logId`, `sthDigest`, `includedBitmapRoot`, `user.voteReceipt`, `inputCommitment`
- `stark_verification`: `imageId`, `proofBundleStatus`

`counted_as_recorded` の check input には `electionManifest`、`closeStatement`、`timestamp` も含まれるが、knowledge panel key ではないため表示されない。

---

## 8. 関連仕様

- レイアウト: `docs/ui/layout-architecture.md`
- デザイン: `docs/ui/design-spec-transparent-trust.md`
- UI-facing API: `docs/ui/api-contract.md`
- verify page: `docs/ui/verify-page/verify-page.md`
