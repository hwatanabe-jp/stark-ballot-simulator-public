# セッションライフサイクル

このページでは、セッション管理の実装をクライアント側とサーバー側に分けて説明します。

## 1. 管理責務の分離

| 管理面               | 主な保存先                                                               | 主な責務                                                                  |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| クライアント共有     | `localStorage` (`starkBallotSession`, `starkBallotSessionSchemaVersion`) | 画面遷移フェーズ、クライアント TTL、検証継続状態、UI 復元、スキーマ無効化 |
| クライアントタブ単位 | `sessionStorage` (`starkBallotSessionLock`)                              | タブごとの session identity lock、stale tab の fail-closed                |
| サーバー             | `VoteStore` 実装（Mock/File/DynamoDB）                                   | 投票データ、掲示板、集計結果、検証結果                                    |

クライアントとサーバーのセッション対応付けには `sessionId` と `X-Session-Capability`（署名トークン）が使われます。
ヘッダー、path、query の使い分けは[エンドポイント一覧](endpoints.md#active-browser-と-cli-api-一覧)を参照してください。

### スキーマ更新時のローカルクリア

`ensureClientStorageSchema()` は `starkBallotSessionSchemaVersion` を確認します。
値が一致しない場合は、`starkBallotSession`、`stark-ballot-knowledge`、`starkBallotSessionLock` をまとめてクリアします。

## 2. クライアント側フェーズ

クライアントセッション（`apps/web/src/session/client.ts`）のフェーズは以下の 3 つです。

- `voting`
- `finalizing`
- `verifying`

ここでの「canonical な `finalizeResult`」とは、現行契約で受理可能な集計スナップショットを指します。

### 主な遷移トリガー

- `POST /api/session` の成功後、`generateSessionId(sessionId, capabilityToken, contractGeneration)` が `voting` を開始します。
- `aggregate` 画面で非同期集計の `pending` または `running` を検知すると、identity-scoped helper が `phase: 'finalizing'` を保存します。
- `aggregate` 画面または `result` 画面で canonical な `finalizeResult` を保存できると、identity-scoped helper が `phase: 'verifying'` へ進めます。
- `/result` から `/verify` へ進む時は `verificationRequestedAt` を保存し、必要に応じて `POST /api/verification/run` を先行起動します。
- `/verify` の継続判定（フロー視点の説明は [設計と実行フロー](../verification/design-and-flow.md) を参照）:
  1. `verificationRequestedAt` と canonical な `finalizeResult` の両方がそろっていれば継続扱い（`hasContinuationAuthority`）
  2. 上記がなくても、サーバー返却の STARK 状態が `not_run` 以外なら進行できる
  3. `hasContinuationAuthority` 不成立かつ STARK が `not_run` の場合はブロックする

## 3. クライアント TTL 実装

`SESSION_PHASE_TIMEOUTS_MS`:

- `voting`: 30 分
- `finalizing`: 30 分
- `verifying`: 24 時間

### TTL 更新箇所

- `generateSessionId(...)` は新規セッション作成時に `expiresAt` を設定します。
- `saveSessionData(...)` と `saveSessionDataForIdentity(...)` はフェーズを加味して `expiresAt` を再計算します。
- `updateLastActivity(...)` と `updateLastActivityForIdentity(...)` は現在フェーズで `expiresAt` を再延長します。

### 期限切れ判定

`checkTimeout()`、`getSessionData*()`、`saveSessionData*()`、`updateLastActivity*()` は有効期限超過を検出すると `clearSession()` を実行します。

### 検証画面での延長と正規化

専用の heartbeat API はありません。
verify 画面では、クライアントが 60 秒間隔で `updateLastActivityForIdentity()` を呼び出し、ローカル TTL を延長します。
`sanitizeSessionData()` は非 canonical な `finalizeResult` を保存しません。
`phase: 'verifying'` なのに有効な `finalizeResult` がない場合は、`verificationRequestedAt` を削除し、`phase` を `voting` に巻き戻します。

## 4. サーバー側セッション状態

サーバーは `SessionData` に以下を保持します。

- 投票（`votes`, `userVoteIndex`, `botCount`）
- 集計状態（`finalizationState`）
- 集計結果（`finalizationResult`）
- 最終活動時刻（`lastActivity`）

`finalizationState.status` は以下を取り得ます。

- `pending`
- `running`
- `succeeded`
- `failed`
- `timeout`

## 5. サーバー側 TTL と失効の実装差分

サーバー側の失効挙動はストア実装で異なります。

| ストア                 | 失効/TTL の実装                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `MockSessionStore`     | `getActiveSessionCount()` 呼び出し時に `lastActivity` から 5 分超を掃除                                 |
| `FileMockSessionStore` | `getActiveSessionCount()` 呼び出し時に同様に 5 分超を掃除                                               |
| `DynamoSessionStore`   | DynamoDB TTL 属性を保存。通常 session TTL と finalized 後の verification TTL を runtime config から反映 |

### DynamoDB TTL の決定

DynamoDB の TTL は保存時点の実効 finalized 状態で決まります。
finalized 到達後の `finalizationResult` 更新は検証 TTL を維持します。
finalized 前の queue/running 更新は通常 TTL で保存されます。

### セッション作成上限

`/api/session` は `MAX_SESSIONS` を参照します。
上限到達時は `SESSION_LIMIT_EXCEEDED` を返します。

## 6. セッションヘッダーのスコープ

エンドポイントごとの `X-Session-ID` / `X-Session-Capability` の要否は[エンドポイント一覧](endpoints.md#active-browser-と-cli-api-一覧)を参照してください。

`POST /api/session` のみヘッダー不要で、それ以外の active browser / CLI API は少なくとも一方が必須です。

## 7. マルチタブ時の分離

`localStorage` は同一オリジンで共有されます。
現行実装は `sessionStorage` の tab lock を併用し、別タブがセッションを差し替えたら stale tab を fail-closed にします。

### 代表的な結果

- 片方のタブで投票済み後、別タブで再投票すると `ALREADY_VOTED` になります。
- 片方のタブで集計完了後、別タブで再集計すると `SESSION_ALREADY_FINALIZED` になります。
- 別タブでセッションが差し替えられた場合、aggregate、result、verify、bot progress を開いている stale tab は進行を停止します。
- セッション作成を並行すると `starkBallotSession` 自体は共有更新されます。
- 先に開いていたタブは `starkBallotSessionLock` と不一致になり、継続利用できません。

<!-- source: apps/web/src/session/client.ts, apps/web/src/session/types.ts, apps/web/src/session/storageSchema.ts, apps/web/src/routes/HomePage.tsx, apps/web/src/routes/aggregate/page.tsx, apps/web/src/routes/result/page.tsx, apps/web/src/routes/verify/page.tsx, packages/domain/src/types/server.ts, packages/domain/src/types/voteStore.ts, packages/aws-adapters/src/store/mockSessionStore.ts, packages/aws-adapters/src/store/fileMockSessionStore.ts, packages/aws-adapters/src/store/dynamoSessionStore.ts -->
