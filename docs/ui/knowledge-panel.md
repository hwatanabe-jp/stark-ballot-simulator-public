# 知識パネル仕様（CURRENT / 実装準拠）

> 最終更新: 2026-10-29
> 主な実装 authority: `apps/web/src/knowledge/{types,normalizer,admission,store,visibility}.ts`、
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
- UI は単一カラムで、画面幅にかかわらず本文末尾の通常フローに同じパネルを表示する。検証項目を選択すると、対応する既存値をその行の直下でも読める。
- `/` と `/privacy` / `/terms` 系では知識パネルを表示しない。

---

## 2. Snapshot の保存、所有権、admission

### 2.1 保存 API

- 保存キーは `localStorage` の `stark-ballot-knowledge`。
- API/route projection からの取り込みは `mergeKnowledgeFromApi(apiData, options?)`、型付きの knowledge patch の追加は `saveKnowledgeData(data, options?)` を使う。
- `mergeKnowledgeFromApi()` は入力を正規化し、`omitKeys` を適用した後、store 内部の `saveKnowledgeCandidate()` で admission する。公開 `saveKnowledgeData()` も同じ経路を通す。current shape の検証は `knowledge/admission.ts` の `isCurrentKnowledgeData()` が所有し、store は保存済み snapshot の read と write candidate 全体の両方に同じ validator を使う。
- `undefined` の patch 値は既存値を削除せず無視する。値が実際に変化したキーだけを新規/更新項目として通知し、通知 phase は最初の変更キーから導出する。

### 2.2 セッション所有権と複数タブ

- knowledge write は、明示された `sessionId`、`expectedSessionId`、または active session に束縛される。
- 既存 snapshot と異なる新しい `sessionId` を受け入れる場合、以前の knowledge を引き継がず、新しい `sessionId` を基点に作り直す。
- `expectedSessionId` が active session と一致しない場合や、別タブが session を置き換えて現在の tab lock が stale になった場合、read/write は knowledge を返さず、置換後の共有 snapshot を変更しない。
- 表示用の `useKnowledgeItems()` は `useSyncExternalStore` で同一タブの knowledge 更新と、session / knowledge の `storage` event を購読する。snapshot の取得時は通知内容をそのまま表示せず、必ず既存の `getKnowledgeItems()` admission を通して読み直す。同じ内容の snapshot は参照を共有する。`clearKnowledge()` と、対象 snapshot を削除した `clearKnowledgeForSession()`、bot 項目を削除した `clearBotKnowledge()` は削除後に購読者へ通知し、描画済みの値も消す。
- `KnowledgeItem` は key に対応する値の型を保持する判別 union で、公開する項目配列と内部の値は readonly とする。admission 済みの `KnowledgeData` から項目への投影は `knowledgeItemsFromData()` に集約し、Storybook の型付き fixture でも同じ関数を使う。renderer は項目の key で値を絞り込み、表示箇所ごとの型 cast を行わない。投影は raw API / storage の admission を代替せず、readonly も TypeScript の契約であり、runtime の入力検証や object freeze の代わりではない。
- active session があるのに snapshot に `sessionId` がない場合は、その snapshot を削除する。snapshot の `sessionId` が active session と異なる場合は表示しないが、別セッション所有の共有 snapshot は削除しない。
- 保存済み session 自体が current session shape に適合しない場合、session admission が session、knowledge、tab lock をまとめて破棄する。
- read は session admission を先に完了してから knowledge snapshot を読む。不正・期限切れ session を破棄した最初の read から旧値を返さない。session admission に伴う削除の `storage` 通知は microtask へ遅延させ、読み取り中の購読者への再入を避ける。

### 2.3 Read/write の fail-closed validation

- 保存済み snapshot は、現在の `KnowledgeData` のキーと値 shape にそのまま適合する場合だけ読み込む。storage schema version marker や read-time migration は使わない。
- malformed JSON、未知キー、retired key、`null`、または不正な current key value を含む、現在の tab が所有する snapshot は、部分修復せず snapshot 全体を拒否して削除する。
- `missingIndices`、`invalidIndices`、`countedIndices`、`excludedCount`、`s3BundleUrl`、`s3BundleExpiresAt`、`proofMode` はすべて current key ではない。保存済みデータから個別削除して再利用することはない。
- write は既存値と patch を合わせた candidate 全体を検証してから永続化する。candidate が不正なら、その値は永続化せず、更新項目の timestamp 登録や listener 通知も行わない。session 所有権の切替や不正な保存済み snapshot の破棄は、candidate の検証前に行う。
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

API resource をブラウザ用 payload に投影し、knowledge store の shape に正規化してから保存する。取り込みは次の順序で行う。

1. route-specific projection が API resource を検証し、ブラウザ用の current payload に投影する。
   - succeeded finalization resource は `projectFinalizationResourceToClientSnapshot()` / `resolveCanonicalFinalizationPayload()` により `ClientFinalizationSnapshot` になる。
   - available verification resource は `projectVerificationResource()` により flat な `VerificationPayload` になる。ここで `verification.steps`、`verifierResult.report`、`journal.representation = "included"` の `journal.value` を、それぞれ `verificationSteps`、`verificationReport`、raw `journal` に投影する。
2. `mergeKnowledgeFromApi()` 内の `normalizeKnowledgeData()` が projected payload の正規フィールドを knowledge key に写す。返値の `KnowledgeCandidate` は値がまだ `unknown` の候補であり、型付きの保存 API へ直接渡す値ではない。`omitKeys` 適用後、store 内部で candidate 全体を admission してから保存・通知する。

`normalizeKnowledgeData()` が受け取るのは、route-specific projection を終えた payload である。raw finalization/verification resource を直接渡して nested API resource envelope の解析に使うことはできない。

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

public group は常に最後に置く。表示可能な値がない group は見出しごと表示しない。`missingSlots` / `invalidPresentedSlots` / `validVotes` / `excludedSlots` は slot-based metric、`rejectedRecords` は record-based metric である。`tally.tamperedCount` は通常 journal の `excludedSlots` を反映し、シナリオ由来の改ざん件数があればその count も反映しうる。既存の「除外数」ラベルでは発表結果の改ざんを投票の除外と誤解しうるため、現在のパネルと行直下の表示からは省く。snapshot / normalizer の field 自体は変更せず、ラベルの改名もしない。

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

### 5.2 通常フローの単一パネル

- デスクトップとモバイルで同じパネルインスタンスを本文末尾に表示する。浮遊、ドッキング、内部スクロール、ボトムシートとその spacer は使用しない。
- 白地と上罫線で本文と区切り、グループ内の値は最大 `64ch` の1列に並べる。画面が狭い場合は値を折り返す。
- パネルの高さは内容に従う。スクロール位置やviewportに応じた再マウントは行わない。

### 5.3 展開と選択

- 初期状態は session group を展開する。その他の非空 group はボタンで開閉し、「展開 / 縮小」で現在存在する group をまとめて操作できる。
- 検証項目の明示的な選択に対応する既存値があれば、その group を開き、選択状態を静的に示す。値の更新だけで画面をスクロールしたり、選択を時間で解除したりしない。
- 行直下の `KnowledgeEvidence` は、現在の route で許可された key と check input の積集合に対して、admission 済み snapshot に実在する値だけを表示する。新しい説明文や receipt の内部 field は追加しない。
- `selectKnowledgeItems()` は hidden key と `tally.tamperedCount` を常に除外し、同じ選択規則をパネルと行直下で使用する。検証開始前の receipt / inclusion proof の保存禁止は既存 route boundary の責務として維持する。
- Storybookの明示的なfixtureは実ストアを購読せず、fixtureから実ストアへ切り替える最初の描画から現在値を読む。
- Store の `isNew` / timestamp は維持するが、UI の新規 dot、通知アニメーション、透明・blur・pulse・開閉の ViewTransition は使用しない。値や展開状態が変わっても文字をいったん透明にしない。
- パネル全体には `aria-live` を付けない。ボタンの展開状態を `aria-expanded` と `aria-controls` で示し、操作中のフォーカスを維持する。

### 5.4 値フォーマット

- label は `knowledge.items.*` の i18n を使い、未定義なら `knowledge.items.<key>` の translation key を表示する。
- hash は `0x` を付けた全体を等幅で表示し、折り返す。ブラウザ標準のテキスト選択でコピーできる。コピー専用の擬似ボタン、clipboard API、コピー結果の通知は使用しない。
- number は `toLocaleString()`、個別書式を持たない object は field 数で要約する。
- `proofBundleStatus`: 未ダウンロード / ダウンロード済。
- `botVotesStatus`: pending/completed と、存在すれば total。
- `tally.counts`: `A:1 B:2 ...`。
- `user.merklePath` / `bot.merklePath`: `idx:<leafIndex> / <treeSize>`。
- `user.voteReceipt`: `#<bulletinIndex>`。
- `receiptPublication` は必須の `receiptHash` を hash 表示する。不完全な publication を別書式で補完しない。
- `null` / `undefined` は表示項目を作らない。fixture も現在の key/value 型に従う。

---

## 6. Route lifecycle

### 6.1 Session と vote

1. `/` で `POST /api/sessions` が成功すると、session identity を初期化し、`mergeKnowledgeFromApi({ ...session })` で `sessionId`、`electionId`、`electionConfigHash`、`logId` を保存する。`sessionId` は表示しない。
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
3. server-validated data がそろうと verification sequence を自動開始する。ただし STARK status が `not_run` の場合は continuation authority も必要とし、direct access だけでは開始しない。必要な STARK 検証の開始・polling を待つ間は、canonical `user.voteReceipt` / `user.merklePath` を保存しない。
4. 待機後に開始時の session identity と中断状態を再確認し、取得済みの最新 payload から canonical `user.voteReceipt` / `user.merklePath` を同じ expected session に保存して、初めてパネル表示を許可する。解決済みの4 stage も一括表示し、表示用 timer による段階的な演出は行わない。unmount、session replacement、または continuation authority の失効で中断した場合、遅れて返った結果から evidence や完了状態を公開しない。
5. bundle/report candidate は、safe な current `sessionId` と payload 自身の `finalizationId` から authenticated endpoint を組み立てる。nested identity、署名 URL、保存済み S3 URL への fallback はない。
6. bundle candidate がある場合は未設定の `proofBundleStatus` を `not_downloaded` にする。`useVerificationArtifacts()` は authenticated bundle download と、report candidate がある場合は protected report の取得も成功した後にだけ `downloaded` に更新する。bundle 取得後に report 取得が失敗した場合も、完了状態には更新しない。URL や expiry は knowledge に保存しない。

---

## 7. 検証項目と既存値の対応

check input の authority は `packages/verification/src/verification/verification-checks.ts` の check definition である。`getVerificationStepInputs()` は stage 内の全 check input を集約し、API resource admission は stage inventory と inputs がこの canonical metadata に一致することを要求する。`projectVerificationResource()` は admission 済みの step inputs をコピーする。

stage ごとに集約した input のうち、knowledge key として定義されているものは次のとおり。

- `cast_as_intended`: `electionId`, `user.choice`, `user.random`, `user.commitment`, `user.voteId`
- `recorded_as_cast`: `user.commitment`, `user.voteReceipt`, `user.merklePath`, `treeSize`, `bulletinRoot`, `sthDigest`
- `counted_as_recorded`: `proofBundleStatus`, `bulletinRoot`, `treeSize`, `tally.counts`, `tally.totalVotes`, `missingSlots`, `invalidPresentedSlots`, `totalExpected`, `electionId`, `electionConfigHash`, `logId`, `sthDigest`, `includedBitmapRoot`, `user.voteReceipt`, `inputCommitment`
- `stark_verification`: `imageId`, `proofBundleStatus`

`counted_as_recorded` の check input には `electionManifest`、`closeStatement`、`timestamp` も含まれるが、knowledge panel key ではないため表示されない。

行直下の evidence は stage 全体の inputs ではなく、選択した check の `inputs`（check がない場合は definition の `inputs`）から選ぶ。現在の route filter と snapshot に実在する値との積集合だけを表示し、verification sequence の完了後、その check に表示可能な値がある場合だけ選択できる。

---

## 8. 関連仕様

- レイアウト: `docs/ui/layout-architecture.md`
- デザイン: `docs/ui/design-spec-transparent-trust.md`
- UI-facing API: `docs/ui/api-contract.md`
- verify page: `docs/ui/verify-page/verify-page.md`
