# 知識パネル仕様（CURRENT / 実装準拠）

> 最終更新: 2026-04-24
> 対象実装: `src/components/knowledge/*`, `src/lib/knowledge/*`, `src/components/LayoutProvider.tsx`, `src/app/(routes)/verify/*`

本書は **現在の実装** を正として整理する。  
`knowledge-panel.md` の TO-BE を反映済みで、以後は本書を正とする。

---

## 1. 目的と前提

- 知識パネルは「**ユーザーが知り得る情報のスナップショット**」を表示する。
- データソースは **クライアントのみ**（`localStorage`）。サーバー同期はしない。
- **単一カラム UI**（`layout-architecture.md`）に合わせ、デスクトップは浮遊/ドッキング、モバイルはボトムシートで表示する。
- `/`（トップ）と `/privacy` / `/terms` 系では **知識パネルを表示しない**。

---

## 2. データストア（実装仕様）

### 2.1 永続化

- 保存先: `localStorage` の `stark-ballot-knowledge`
- API からの取り込みは `mergeKnowledgeFromApi()`、個別追加は `saveKnowledgeData()`。
- Bot 用は `mergeBotKnowledge()`（`/api/botdata/:id`）を使用。
- active session と異なる snapshot は表示せず、session schema version が変わった場合は stale な session / knowledge / lock をまとめて破棄する。
- retired key は読み込み時に削除する。対象は `missingIndices`, `invalidIndices`, `countedIndices`, `excludedCount`, `s3BundleUrl`, `s3BundleExpiresAt`, `proofMode`。

### 2.2 クリアタイミング

- `/` に遷移した時点で `clearKnowledge()` を実行
- Header の「やり直す」実行時
- `/result` の「最初からやり直す」実行時

---

## 3. 正規化ルール（実装）

`src/lib/knowledge/normalizer.ts` に準拠。

> **方針**: `normalizer.ts` は「正規名以外を黙殺する厳格ガード」として維持する。

### 3.1 フィールド名の正規化

- **旧名/別名は受け付けない**（正規名のみ）。
- `normalizeKnowledgeData()` は **正規キーのみ保存**し、旧名は無視する。
  - 例: `merkleRoot`, `tally.merkleRoot`, `rootAtTime`, `zkVMInputCommitment`, `proofMode: "ct"` などは **保存しない**。
  - `proofMode` は retired key であり、値が `rfc6962` でも保存しない。proof object に `proofMode` が含まれる場合も canonical proof として扱わない。
- **変換対象は「正規APIフィールド → knowledge key」だけ**とし、alias を正規名に変換しない。
  - 例: `vote → user.choice` は **OK**、`merkleRoot → bulletinRoot` は **NG**

### 3.2 ネスト解体

- `userVote.*` → `user.*`
- `userVote.proof` / `proof` → `user.merklePath`
- `voteReceipt` → `user.voteReceipt`（オブジェクト保持）
- `tally` → `tally.counts` / `tally.totalVotes` / `tally.tamperedCount`
- `verificationSteps` → `verification.steps`
- `verificationReport` → `verification.reportSummary`
- `journal` → `bulletinRoot`, `treeSize`, `totalExpected`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `validVotes`, `excludedSlots`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`

`journal` が supported zkVM journal の場合、公開証跡・完全性メトリクスは `journal` 由来の値を優先する。stale な top-level copy と `journal` が同時に渡された場合も、`journal` が canonical source になる。

### 3.3 Bot データ正規化

- `id` → `bot.id` / `bot.bulletinIndex`
- `vote`, `random`, `commitment`, `voteId`, `timestamp`, `proof` を `bot.*` に展開

---

## 4. レイアウト / 表示形態

### 4.1 バリアント

- **Desktop**: `variant="floating"`（浮遊/ドッキング対応）
  - 通常時: 画面下部に固定表示（浮遊）
  - ドックゾーンが視界に入ると: 本文フローに合流（ドッキング）
  - 浮遊時は **パネル高さ分のスペーサー** を確保し、本文が隠れないようにする
  - 浮遊時は **最大高さ 30vh**、超過分は内部スクロール
  - 内部スクロール位置はドッキング/浮遊の切替で保持する
  - 浮遊→ドッキングでは折りたたみ状態を維持、ドッキング→浮遊ではリセットしてよい
- **Mobile**: `variant="bottomSheet"`（ボトムシート、3段階スナップ）
  - `collapsed`: 60px
  - `mid`: 40vh
  - `expanded`: 80vh

> **補足**: `inline` は従来のカード表示（LayoutProvider では未使用）

### 4.2 タイトル切替

- 通常: 「私が知っている情報」
- ボット view + `bot.*` がある場合: 「ボットが知っている情報」
- 現行 `/verify` では S3/S4 時に bot タブの見た目だけ表示するが、タブは disabled で、`/api/botdata/:id` 取得や Bot モーダルは接続されていない。

### 4.3 展開 / 折りたたみ

- 初期状態は **全グループ折りたたみ**
- 自動展開は行わない
- パネル右上の「展開 / 縮小」ボタンで全体操作

### 4.4 新規追加インジケータ

- `saveKnowledgeData()` で **値が変化したキーのみ** `isNew=true`
- 追加後 **2秒間**:
  - グループヘッダーが「ピコン」アニメーション
  - グループヘッダーに緑ドット
  - 展開時にアイテム左へ緑ドット

### 4.5 ハイライト（検証ステップ連動）

- `/verify` 進行中ステップに応じて **キー単位でハイライト**
- **自動展開・自動スクロールはしない**
- 表示中の項目のみハイライトされる

---

## 5. グループ定義（表示順）

> `src/components/knowledge/KnowledgeGroup.tsx` に準拠

1. **session**
   - `electionId`, `electionConfigHash`, `logId`
2. **vote**
   - `user.choice`, `user.random`, `user.commitment`, `user.voteId`, `user.bulletinIndex`, `user.bulletinRootAtCast`, `botVotesStatus`
3. **result**
   - `proofBundleStatus`
4. **verify**
   - `user.voteReceipt`, `user.merklePath`
5. **bot**
   - `bot.id`, `bot.choice`, `bot.random`, `bot.commitment`, `bot.voteId`, `bot.bulletinIndex`, `bot.bulletinRootAtCast`, `bot.voteTimestamp`, `bot.merklePath`, `bot.verification.steps`
6. **public**（常に最後尾）
   - `tally.counts`, `tally.totalVotes`, `tally.tamperedCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `validVotes`, `excludedSlots`, `totalExpected`, `bulletinRoot`, `treeSize`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `imageId`, `receiptPublication`

> **注**: `tally.tamperedCount` はユーザー向けの「除外数」で、通常系では zkVM journal の `excludedSlots` を反映する。シナリオ由来の改ざん件数が重なる場合は `scenarioTamperCount` も加味した値になりうる。
> `missingSlots` / `invalidPresentedSlots` / `validVotes` / `excludedSlots` は slot-based の公開メトリクスで、record-based の拒否件数は `rejectedRecords` が表す。旧 `missingIndices` / `invalidIndices` / `countedIndices` は knowledge key ではない。

---

## 6. ルート別フィルタ

> `src/components/LayoutProvider.tsx` 準拠

| ルート       | 表示グループ（キー）                         |
| ------------ | -------------------------------------------- |
| `/`          | **非表示**                                   |
| `/vote`      | session + vote                               |
| `/aggregate` | session + vote                               |
| `/result`    | session + vote + result + public             |
| `/verify`    | VERIFY_MY_KEYS / VERIFY_BOT_KEYS（タブ切替） |
| `/privacy`   | **非表示**                                   |
| `/terms`     | **非表示**                                   |
| その他       | 全グループ                                   |

**VERIFY_MY_KEYS**

- `electionId`, `user.choice`, `user.random`, `user.commitment`, `user.voteId`, `user.voteReceipt`, `user.merklePath`,
- `tally.counts`, `tally.totalVotes`, `tally.tamperedCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `validVotes`, `excludedSlots`, `totalExpected`, `bulletinRoot`, `treeSize`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `imageId`, `receiptPublication`,
- `proofBundleStatus`

**VERIFY_BOT_KEYS**

- `bot.*` 系
- `public` グループ全体

---

## 7. 非表示キー（保持のみ）

以下は **保存されるが知識パネルには表示しない**。

- `sessionId`
- `user.voteTimestamp`
- `scenarioId`
- `verification.steps`
- `verification.reportSummary`

`s3BundleUrl` / `s3BundleExpiresAt` は retired delivery key で、保存済み snapshot に残っていても読み込み時に削除される。現在の bundle download は `sessionId` と `verificationExecutionId` から authenticated endpoint を組み立てる。

---

## 8. 表示フォーマット

### 8.1 ラベル

- `knowledge.items.*` の i18n を参照
- 未定義なら **キー名そのまま**表示

### 8.2 値フォーマット

| 種別             | 表示ルール           |
| ---------------- | -------------------- |
| `null/undefined` | 「未設定 / Not set」 |
| boolean          | 「はい/いいえ」      |
| number           | `toLocaleString()`   |
| object           | `N fields`           |

### 8.3 特殊表示

- **ハッシュ**: `0xaaaa…bbbb` 形式で省略（クリックでコピー）
- `proofBundleStatus`: `未ダウンロード / ダウンロード済`（色付き）
- `botVotesStatus`: `pending/completed` + `total`（あれば）
- `tally.counts`: `A:1 B:2 ...` モノスペース
- `verification.steps`: `成功数/全数 verified`
- `receiptPublication`: `receiptHash` を優先、無い場合 `#boardIndex`
- `user.merklePath` / `bot.merklePath`: `idx:<leafIndex> / <treeSize>`
- `user.voteReceipt`: `#<bulletinIndex>`

---

## 9. 追加/更新タイミング（実装準拠）

### 9.1 `/` セッション開始

- `POST /api/session` 成功時に `mergeKnowledgeFromApi('session', data)`
- 追加: `electionId`, `electionConfigHash`, `logId`（`sessionId` は非表示）

### 9.2 `/vote`

- 選択時: `user.choice`
- 投票成功時: `user.random`, `user.commitment`, `user.voteId`, `user.bulletinIndex`, `user.bulletinRootAtCast`, `user.voteTimestamp`
- ボット投票開始: `botVotesStatus = pending`
- ボット投票完了: `botVotesStatus = completed`

### 9.3 `/aggregate`

- 改ざん選択時: `scenarioId`（非表示）
- `POST /api/finalize` の結果（同期/非同期完了）で `mergeKnowledgeFromApi('result', ...)`
  - `user.voteReceipt` / `user.merklePath` は **除外**（検証シーケンス開始まで表示しない）

### 9.4 `/result`

- `resolveCanonicalFinalizationPayload()` で整えた `finalizeResult` を `projectClientFinalizationSnapshotForKnowledge()` 経由で `mergeKnowledgeFromApi('result', ...)` に流す
- 現行実装では `saveKnowledgeData()` で `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `validVotes`, `excludedSlots`, `totalExpected` を再保存する
- `proofBundleStatus` が未設定なら `not_downloaded` を付与

### 9.5 `/verify`

- `GET /api/verify` 成功時に `mergeKnowledgeFromApi('verify', ...)`
  - `user.voteReceipt` / `user.merklePath` は **除外**
- 検証シーケンス開始時に **`user.voteReceipt` / `user.merklePath` を保存**（/verify 到達時に自動開始）
- バンドルDL成功時: `proofBundleStatus = downloaded`
- バンドルDL候補は authenticated endpoint のみ。署名URL値は knowledge に保存しない

### 9.6 `/verify` ボット検証

- `clearBotKnowledge()` / `mergeBotKnowledge()` は store API として存在する
- 現行 `/verify` UI では bot タブは disabled で、ボット取得・Bot モーダル・`bot.*` パネル表示は未接続

---

## 10. 検証ステップのハイライトキー

`/verify` 内部で以下を使用（API が `verificationSteps[].inputs` を返す場合はそれを優先）。

- `cast_as_intended`: `electionId`, `user.choice`, `user.random`, `user.commitment`, `user.voteId`
- `recorded_as_cast`: `user.commitment`, `user.merklePath`, `bulletinRoot`, `treeSize`, `user.voteReceipt`, `sthDigest`
- `counted_as_recorded`: `proofBundleStatus`, `bulletinRoot`, `treeSize`, `tally.counts`, `tally.totalVotes`, `missingSlots`, `invalidPresentedSlots`, `totalExpected`, `electionId`, `electionConfigHash`, `logId`, `sthDigest`, `includedBitmapRoot`, `user.voteReceipt`, `inputCommitment`
- `stark_verification`: `imageId`, `proofBundleStatus`

---

## 11. 参照ファイル

- レイアウト: `docs/current/ui-redesign/layout-architecture.md`
- デザイン仕様: `docs/current/ui-redesign/design-spec-transparent-trust.md`
- API契約: `docs/current/ui-redesign/api-contract.md`
