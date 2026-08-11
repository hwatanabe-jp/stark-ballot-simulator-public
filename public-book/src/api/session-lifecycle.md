# セッションライフサイクル

このページでは、セッション管理の実装をクライアント側とサーバー側に分けて説明します。

## 管理責務の分離

| 管理面               | 主な保存先                                  | 主な責務                                                                                  |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| クライアント共有     | `localStorage` (`starkBallotSession`)       | 画面遷移フェーズ、クライアント TTL、検証継続状態、UI 復元、保存 shape の strict admission |
| クライアントタブ単位 | `sessionStorage` (`starkBallotSessionLock`) | タブごとの session identity lock、stale tab の fail-closed                                |
| サーバー             | `VoteStore` 実装（Mock/File/DynamoDB）      | 投票データ、掲示板、集計結果、検証結果、検証観測メタデータ                                |

クライアントとサーバーのセッション対応付けには `sessionId` と `X-Session-Capability`（署名トークン）が使われます。
ヘッダー、path、query の使い分けは[エンドポイント一覧の共通 contract](endpoints.md#共通-contract)を参照してください。

### 保存状態の strict admission

`admitStoredSessionData()` は、サーバーが発行した identity、lifetime、phase、完全な
private opening / cast receipt のフィールド群、canonical な `finalizeResult` を含む現行 shape だけを
受理します。未知フィールド、欠落したフィールド群、phase と finalization 状態の不一致は
fail-closed です。

読み取り時に保存値が受理できなければ、`starkBallotSession`、`stark-ballot-knowledge`、
`starkBallotSessionLock` をクリアします。書き込み時に受理できない状態は保存せず、
`Invalid browser session state` として失敗します。version key や旧 shape への移行 fallback はありません。

## クライアント側フェーズ

クライアントセッション（`apps/web/src/session/client.ts`）のフェーズは以下の 3 つです。

- `voting`
- `finalizing`
- `verifying`

ここでの「canonical な `finalizeResult`」とは、現行契約で受理可能な集計スナップショットを指します。

### 主な遷移トリガー

| トリガー                                                                                                                            | 動作                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions` の成功                                                                                                         | `initializeSession({ sessionId, capabilityToken, electionId, electionConfigHash, logId })` が `voting` を開始                          |
| `aggregate` 画面で非同期集計の `pending` または `running` を検知                                                                    | identity-scoped helper が `phase: 'finalizing'` を保存                                                                                 |
| `aggregate` 画面または `result` 画面で canonical な `finalizeResult` を保存                                                         | identity-scoped helper が `phase: 'verifying'` へ進める                                                                                |
| `/result` から `/verify` へ進む                                                                                                     | `verificationRequestedAt` を保存し、必要に応じて `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification` を先行起動 |
| `/verify` を開く                                                                                                                    | 下記の継続判定で進行可否を決定                                                                                                         |
| `/verify` の検証シーケンス完了（pending check なし、サーバー検証済みの STARK 状態が terminal な `success` / `failed` / `dev_mode`） | `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations` を best-effort で送信                          |

`/verify` の継続判定（フロー視点の説明は [設計と実行フロー](../verification/design-and-flow.md) を参照）:

1. `verificationRequestedAt` と canonical な `finalizeResult` の両方がそろっていれば継続扱い（`hasContinuationAuthority`）
2. 上記がなくても、サーバー返却の STARK 状態が `not_run` 以外なら進行できる
3. `hasContinuationAuthority` 不成立かつ STARK が `not_run` の場合はブロックする

## クライアント TTL 実装

`SESSION_PHASE_TIMEOUTS_MS`:

- `voting`: 30 分
- `finalizing`: 30 分
- `verifying`: 24 時間

### TTL 更新箇所

- `initializeSession(...)` は新規セッション作成時に `expiresAt` を設定します。
- `saveSessionData(...)` と `saveSessionDataForIdentity(...)` はフェーズを加味して `expiresAt` を再計算します。
- `updateLastActivity(...)` と `updateLastActivityForIdentity(...)` は現在フェーズで `expiresAt` を再延長します。

### 期限切れ判定

`checkTimeout()`、`getSessionData*()`、`saveSessionData*()`、`updateLastActivity*()` は有効期限超過を検出すると `clearSession()` を実行します。

### 検証画面での延長と fail-closed admission

専用の heartbeat API はありません。
verify 画面では、クライアントが 60 秒間隔で `updateLastActivityForIdentity()` を呼び出し、ローカル TTL を延長します。
`phase: 'verifying'` は canonical な `finalizeResult` を必須とし、`verificationRequestedAt` は非負の
整数 timestamp だけを許可します。不正な保存状態をフィールド削除や `voting` への巻き戻しで
修復することはありません。

## サーバー側の lifecycle-owned records

サーバーは一つの optional-field aggregate を永続化しません。

| Record family                 | Authority                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `SessionIdentityRecord`       | required `sessionId` / election config・hash / `electionId` / `logId` / creation time   |
| `SessionVotingRecord`         | votes、append-only bulletin、root history、user participation、bot count、last activity |
| `FinalizationRecord`          | scenario context、state、成功時だけ required な canonical result                        |
| `VerificationResultRecord`    | session と同じ `finalizationId` に scope された検証結果                                 |
| verification observation      | browser が表示した cast-check 状態の非 authority な冪等観測                             |
| AWS runtime/delivery metadata | S3 version/key、Step Functions など adapter-owned metadata                              |

DynamoDB 上で各 record family に対応する key layout は
[トポロジーの Data レイヤ](../aws/topology.md#data-レイヤ)を参照してください。

Application use case は必要な record を `SessionReadModel` に合成できますが、その
shape を persistence authority として保存しません。欠落 record や nested
`finalizationId` の不一致は fail-closed であり、read path は identity や
finalization branch を生成・修復しません。

### 状態遷移 policy と永続化

finalization と session mutation の semantic decision は application の transition
policy/coordinator が所有します。現在状態と command から applied、idempotent、
stale/rejected、fail-closed の結果を決め、adapter はその結果を lock、transaction、
conditional write など各 backend の atomic persistence へ変換します。

Mock、File、Dynamo の各実装は独自の状態遷移表を持たず、I/O、serialization、
TTL、encryption、storage index、delivery metadata に集中します。この責務分離は
特定時点の store method 数や optional field 数には依存しません。

`FinalizationRecord.state.status` は以下を取り得ます。

- `pending`
- `running`
- `succeeded`
- `failed`
- `timeout`

### 検証観測メタデータ

verification observation record は、現在の `finalizationId` に対応する最初のブラウザ観測を
`finalizationId`、`fingerprint`、`observedAt` で記録します。同じ finalization と
fingerprint の再送は冪等に受理し、finalization または fingerprint が競合する送信は
拒否します。

この記録は、ブラウザで表示された verdict の観測、observability event の重複送信防止、および
送信された限定的な cast check 状態からの observability 用 summary 導出に使う冪等マーカーであり、
その送信の成否や保存によって proof、集計結果、検証結果、ユーザー向け verdict は変わりません。

## サーバー側 TTL と失効の実装差分

サーバー側の失効挙動はストア実装で異なります。

| ストア                 | 失効/TTL の実装                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MockSessionStore`     | `getActiveSessionCount()` 呼び出し時に `lastActivity` から 5 分超を掃除                                          |
| `FileMockSessionStore` | `getActiveSessionCount()` 呼び出し時に同様に 5 分超を掃除                                                        |
| `DynamoSessionStore`   | DynamoDB TTL 属性を保存。live session TTL と finalization / verification artifact TTL を runtime config から反映 |

### DynamoDB TTL の決定

セッション作成は `SESSION_LIVE_TTL_SECONDS` で identity と voting の期限を初期化します。
以後の activity / vote mutation は identity、voting、既存・新規 vote record の期限を
`max(現在の期限, 現在時刻 + live TTL)` に揃え、一つの conditional transaction で更新します。
競合や欠落時は部分更新を残しません。finalization lifecycle の applied transition は全 session record を
`VERIFICATION_ARTIFACT_TTL_SECONDS` へ昇格し、以後の live activity もその期限を短縮しません。
finalization / verification の artifact、observation、adapter metadata も artifact TTL で保存されます。

`getActiveSessionCount()` がセッション作成上限用に行う 5 分の最終 activity 判定は、
DynamoDB レコードの物理 TTL とは別の判定です。

### セッション作成上限

`POST /api/sessions` は `MAX_SESSIONS` を参照します。
上限到達時は `SESSION_LIMIT_EXCEEDED` を返します。

## セッションヘッダーのスコープ

`POST /api/sessions` 以外の session-scoped API は、path の `:sessionId` と `X-Session-Capability` で
session owner を特定します。エンドポイントごとの要否と共通エラーは
[エンドポイント一覧の共通 contract](endpoints.md#共通-contract)を参照してください。

## マルチタブ時の分離

`localStorage` は同一オリジンで共有されます。
現行実装は `sessionStorage` の tab lock を併用し、別タブがセッションを差し替えたら stale tab を fail-closed にします。

### 代表的な結果

- 片方のタブで投票済み後、別タブで再投票すると `ALREADY_VOTED` になります。
- 片方のタブで集計完了後、別タブで再集計すると `SESSION_ALREADY_FINALIZED` になります。
- 別タブでセッションが差し替えられた場合、aggregate、result、verify、bot progress を開いている stale tab は進行を停止します。
- セッション作成を並行すると `starkBallotSession` 自体は共有更新されます。
- 先に開いていたタブは `starkBallotSessionLock` と不一致になり、継続利用できません。

<!-- source: apps/web/src/session/client.ts, apps/web/src/session/types.ts, apps/web/src/session/storage.ts, apps/web/src/session/storageAdmission.ts, apps/web/src/routes/HomePage.tsx, apps/web/src/routes/aggregate/page.tsx, apps/web/src/routes/result/page.tsx, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationObservation.ts, apps/api/src/server/api/handlers/verificationObservation.ts, packages/api-contract/src/routes/inventory.ts, packages/domain/src/types/sessionRecords.ts, packages/domain/src/types/voteStore.ts, packages/domain/src/types/verificationObservation.ts, packages/application/src/session/session-read-model.ts, packages/application/src/finalize/finalization-record.ts, packages/application/src/finalize/finalization-result-store.ts, packages/aws-adapters/src/store/mockSessionStore.ts, packages/aws-adapters/src/store/fileMockSessionStore.ts, packages/aws-adapters/src/store/dynamoSessionStore.ts -->
