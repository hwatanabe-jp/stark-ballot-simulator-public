# セッションの保存と継続

投票から証明の検証までは、複数の画面を移動します。再読み込みで投票時の情報を失うことも、別タブで作ったセッションの結果を今の票と取り違えることも避ける必要があります。

## ブラウザとサーバーに残すもの

| 保存先                                       | 内容                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `localStorage` の `starkBallotSession`       | セッション ID と鍵、投票時の情報とレシート、画面の進行段階、期限、集計結果 |
| `sessionStorage` の `starkBallotSessionLock` | そのタブが操作しているセッションの識別情報                                 |
| サーバーの `VoteStore`                       | 投票、掲示板、集計状態・結果、検証結果、検証画面からの観測記録             |

ブラウザとサーバーの対応は、URL の `sessionId` と `X-Session-Capability` で確認します。集計・検証のデータでは `finalizationId` も照合します。

保存されたブラウザの値も無条件には信用しません。`admitStoredSessionData()` が識別情報、期限、進行段階、投票の秘密情報とレシートの組、集計結果を検査します。未知のフィールドや必要な組の欠落、段階と集計状態の矛盾があれば拒否します。

読み取りで不正な値が見つかった場合は、`starkBallotSession`、`stark-ballot-knowledge`、`starkBallotSessionLock` を消去します。書き込みであれば保存せず `Invalid browser session state` として失敗します。情報の一部を削って、整合しているように見せる修復は行いません。

## 投票から検証へ進む条件

ブラウザの進行段階は次の三つです。集計の `pending` や `succeeded` とは別に、画面を継続するために保存します。

| 段階         | 保存するタイミング                                     | クライアント側の期限 |
| ------------ | ------------------------------------------------------ | -------------------- |
| `voting`     | セッション作成成功時                                   | 30 分                |
| `finalizing` | 非同期集計の `pending` または `running` を確認したとき | 30 分                |
| `verifying`  | 検査済みの集計結果 `finalizeResult` を保存したとき     | 24 時間              |

Result から Verify へ進むときは、検証を要求した時刻 `verificationRequestedAt` を保存し、必要なら STARK 検証を先に開始します。Verify は次の条件で継続を判断します。

1. 正しい `finalizeResult` と `verificationRequestedAt` が揃っていれば継続できる。
2. それらが揃わなくても、サーバーの STARK 検証が `not_run` 以外なら進める。
3. どちらも満たさなければ、検証を始める根拠がないため停止する。

ここで受け入れる `finalizeResult` は、現行のデータ形式と整合条件を満たす集計結果です。`verifying` 段階では必須であり、要求時刻は非負の整数だけを許します。

## 投票の応答を受け取れなかった場合

送信前に選択・乱数・コミットメントの組を保存します。応答が不明な間はその組を固定し、
再試行や再読み込みで新しい乱数を生成しません。同じ内容の再送でサーバーに残る票のレシートを回収し、
不足するボット票の保存を完了させます。Turnstile が必要な環境では、再試行用のトークンを改めて取得します。

サーバーは再送で票 ID や投票時刻を更新しません。異なる内容の再投票と、集計開始後の票の追記は拒否します。
DynamoDB の競合再試行でも保存時の票数上限を検査するため、同時にボット補完が走っても63票を超えて追記しません。

## 再読み込みと別タブ

同じオリジンのタブは `localStorage` を共有します。片方で新しいセッションを作ると、もう片方の画面に残る情報と保存値が食い違う可能性があります。タブごとのロックを比較し、古いセッションを見ている aggregate、result、verify、bot progress の画面は進行を止めます。

同じセッションへの二重操作はサーバーでも拒否します。投票済みなら `ALREADY_VOTED`、集計完了後の再集計なら `SESSION_ALREADY_FINALIZED` を返します。

クライアントの期限は、保存や活動時刻の更新でその段階に応じて延長します。Verify では 60 秒ごとにローカルの活動時刻を更新します。これはブラウザ内の更新であり、サーバーの期限を延長する heartbeat API ではありません。期限切れを検出すると `clearSession()` で保存状態を消去します。

## サーバーでは状態ごとに記録する

サーバーは、セッションのすべてを一つの可変オブジェクトとして保存するのではなく、意味の異なる記録を分けます。

| 記録                       | 内容                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `SessionIdentityRecord`    | セッション・選挙・ログの ID、選挙設定とそのハッシュ、作成時刻 |
| `SessionVotingRecord`      | 票、追記式の掲示板、ルート履歴、参加状況、活動時刻            |
| `FinalizationRecord`       | シナリオ、集計状態、成功した場合の集計結果                    |
| `VerificationResultRecord` | 同じ集計 ID に結び付いた検証結果                              |
| verification observation   | ブラウザが表示した Cast チェックの観測                        |
| AWS の保存・配送情報       | S3 のキーとアップロード時刻、Step Functions などの実行情報    |

読み出す際は必要な記録を `SessionReadModel` にまとめられますが、その合成結果を保存用の正本にはしません。必要な記録の欠落や内部の集計 ID の不一致を見つけた場合は、値を作り足さずエラーとして扱います。

集計の状態は `pending`、`running`、`succeeded`、`failed`、`timeout` です。現在の状態と操作から、更新するか、同じ操作の再送か、古い操作として拒否するかを application 層で決めます。Mock・File・DynamoDB の各保存実装は、その判断をロックや条件付きトランザクションで反映します。

## 検証画面からの観測を保存する

検証シーケンスが完了すると、ブラウザは Cast チェックの観測を送ります。サーバーは最初の観測を `finalizationId`、内容の `fingerprint`、`observedAt` で記録し、同じ集計と同じ内容の再送を受け入れます。集計や内容が競合する送信は拒否します。

この記録は、利用者にどの状態が見えたかを調べ、観測イベントの重複を防ぐためのものです。送信や保存に失敗しても、証明、集計結果、検証結果、画面の判定は変更しません。

## 保存期間とセッション数の制限

クライアントの期限と、サーバーにデータが残る期間は別です。

| 保存実装                                    | 期限の扱い                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `MockSessionStore` / `FileMockSessionStore` | `getActiveSessionCount()` の際、最終活動から 5 分を超えたセッションを掃除する |
| `DynamoSessionStore`                        | 設定値から DynamoDB の TTL 属性を保存する                                     |

DynamoDB では、作成時に `SESSION_LIVE_TTL_SECONDS` を使います。その後の投票や活動では、識別情報、投票状態、各票の期限を「現在の期限」と「現在時刻に live TTL を加えた値」の大きい方に揃え、条件付きトランザクションで更新します。競合や欠落で一部だけを更新することはありません。

集計状態の更新が適用されると、セッションの記録を `VERIFICATION_ARTIFACT_TTL_SECONDS` の期限へ移し、後の活動で短縮しません。検証結果、観測、保存・配送情報にもこの証拠用の TTL を使います。

一方、セッション作成上限を判定する際は、最終活動から 5 分以内かを調べます。この活動判定は DynamoDB の物理的な削除時刻とは別です。作成数が `MAX_SESSIONS` に達すると、`POST /api/sessions` は `SESSION_LIMIT_EXCEEDED` を返します。

<!-- source: apps/web/src/session/client.ts, apps/web/src/session/types.ts, apps/web/src/session/storage.ts, apps/web/src/session/storageAdmission.ts, apps/web/src/routes/HomePage.tsx, apps/web/src/routes/aggregate/page.tsx, apps/web/src/routes/result/page.tsx, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationObservation.ts, apps/api/src/server/api/handlers/verificationObservation.ts, packages/api-contract/src/routes/inventory.ts, packages/domain/src/types/sessionRecords.ts, packages/domain/src/types/voteStore.ts, packages/domain/src/types/verificationObservation.ts, packages/application/src/session/session-read-model.ts, packages/application/src/finalize/finalization-record.ts, packages/application/src/finalize/finalization-result-store.ts, packages/aws-adapters/src/store/mockSessionStore.ts, packages/aws-adapters/src/store/fileMockSessionStore.ts, packages/aws-adapters/src/store/dynamoSessionStore.ts -->
