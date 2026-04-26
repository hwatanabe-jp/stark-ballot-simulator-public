# セッションライフサイクル

この文書は、セッション管理の実装を クライアント側とサーバー側に分けて説明します。

## 1. 管理責務の分離

| 管理面               | 主な保存先                                                               | 主な責務                                                                  |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| クライアント共有     | `localStorage` (`starkBallotSession`, `starkBallotSessionSchemaVersion`) | 画面遷移フェーズ、クライアント TTL、検証継続状態、UI 復元、スキーマ無効化 |
| クライアントタブ単位 | `sessionStorage` (`starkBallotSessionLock`)                              | タブごとの session identity lock、stale tab の fail-closed                |
| サーバー             | `VoteStore` 実装（Mock/File/Amplify）                                    | 投票データ、掲示板、集計結果、検証結果                                    |

クライアントとサーバーのセッション対応付けには `sessionId` と `X-Session-Capability`（署名トークン）が使われます。
ヘッダー / path / query の使い分けは[エンドポイント一覧](endpoints.md#外部クライアント向け-api-一覧)を参照してください。

補足:

- `ensureClientStorageSchema()` は `starkBallotSessionSchemaVersion` を確認し、不一致時は `starkBallotSession`、`stark-ballot-knowledge`、`starkBallotSessionLock` をまとめてクリアします。

## 2. クライアント側フェーズ

クライアントセッション（`src/lib/session/client.ts`）のフェーズは以下の 3 つです。

- `voting`
- `finalizing`
- `verifying`

ここでの「canonical な `finalizeResult`」とは、現行契約で受理可能な集計スナップショットを指します。

主な遷移トリガー:

- `POST /api/session` 後に `generateSessionId(sessionId, capabilityToken, contractGeneration)` で `voting` 開始
- `aggregate` 画面で非同期集計の `pending`/`running` を検知すると identity-scoped helper で `phase: 'finalizing'` を保存
- `aggregate` または `result` 画面で canonical な `finalizeResult` を保存できると identity-scoped helper で `phase: 'verifying'` へ進む
- `/result` から `/verify` へ進む時は `verificationRequestedAt` を保存し、`POST /api/verification/run` を必要に応じて先行起動する
- `/verify` の継続判定:
  1. `verificationRequestedAt` と canonical な `finalizeResult` の両方がそろっていれば継続扱い（`hasContinuationAuthority`）
  2. 上記がなくても、サーバー返却の STARK 状態が `not_run` 以外なら進行できる
  3. `hasContinuationAuthority` 不成立かつ STARK が `not_run` の場合はブロックする

## 3. クライアント TTL 実装

`SESSION_PHASE_TIMEOUTS_MS`:

- `voting`: 30 分
- `finalizing`: 30 分
- `verifying`: 24 時間

TTL 更新の実装ポイント:

- `generateSessionId(...)`: 新規作成
- `saveSessionData(...)` / `saveSessionDataForIdentity(...)`: フェーズを加味して `expiresAt` を再計算
- `updateLastActivity(...)` / `updateLastActivityForIdentity(...)`: 現在フェーズで `expiresAt` を再延長

期限切れ判定:

- `checkTimeout()`、`getSessionData*()`、`saveSessionData*()`、`updateLastActivity*()` は有効期限超過を検出すると `clearSession()` を実行

補足:

- 専用の heartbeat API はなく、verify 画面でクライアントが 60 秒間隔で `updateLastActivityForIdentity()` を呼びローカル TTL を延長します。
- `sanitizeSessionData()` は非 canonical な `finalizeResult` を保存しません。`phase: 'verifying'` なのに有効な `finalizeResult` がない場合は `verificationRequestedAt` を削除し、`phase` を `voting` に巻き戻します。

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

## 5. サーバー側 TTL / 失効の実装差分

サーバー側の失効挙動はストア実装で異なります。

| ストア                 | 失効/TTL の実装                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MockSessionStore`     | `getActiveSessionCount()` 呼び出し時に `lastActivity` から 5 分超を掃除                                                                                           |
| `FileMockSessionStore` | `getActiveSessionCount()` 呼び出し時に同様に 5 分超を掃除                                                                                                         |
| `AmplifySessionStore`  | TTL 属性を保存。初期は `AMPLIFY_DATA_TTL_SECONDS`（既定 1800 秒）、実効状態が finalized の保存では `AMPLIFY_DATA_VERIFICATION_TTL_SECONDS`（既定 86400 秒）へ延長 |

補足:

- Amplify の TTL は保存時点の実効 finalized 状態で決まります。finalized 到達後の `finalizationResult` 更新は検証 TTL を維持し、finalized 前の queue/running 更新は通常 TTL で保存されます。

重要事項:

- `/api/session` は `MAX_SESSIONS` を参照し、上限到達時は `SESSION_LIMIT_EXCEEDED` を返します。

## 6. セッションヘッダースコープ

エンドポイントごとの `X-Session-ID` / `X-Session-Capability` の要否は[エンドポイント一覧](endpoints.md#外部クライアント向け-api-一覧)を参照してください。

`POST /api/session` のみヘッダー不要で、それ以外の外部クライアント向け API は少なくとも一方が必須です。

## 7. マルチタブ時の実務上の注意

`localStorage` は同一オリジンで共有されますが、現行実装は `sessionStorage` の tab lock を併用し、別タブがセッションを差し替えたら stale tab を fail-closed にします。

代表的な結果:

- 片方のタブで投票済み後、別タブで再投票すると `ALREADY_VOTED`
- 片方のタブで集計完了後、別タブで再集計すると `SESSION_ALREADY_FINALIZED`
- 別タブでセッションが差し替えられた場合、aggregate / result / verify / bot progress を開いている stale tab は進行を停止する
- セッション作成を並行すると `starkBallotSession` 自体は共有更新されますが、先に開いていたタブは `starkBallotSessionLock` と不一致になり継続利用できません

<!-- source: src/lib/session/client.ts, src/lib/session/types.ts, src/lib/session/storageSchema.ts, src/app/(routes)/page.tsx, src/app/(routes)/aggregate/page.tsx, src/app/(routes)/result/page.tsx, src/app/(routes)/verify/page.tsx, src/types/server.ts, src/types/voteStore.ts, src/lib/store/mockSessionStore.ts, src/lib/store/fileMockSessionStore.ts, src/lib/store/amplifySessionStore.ts -->
