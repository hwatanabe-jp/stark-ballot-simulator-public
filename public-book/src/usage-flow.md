# 利用フロー

このページは、ブラウザでの通常利用順と、その裏で使われる API を一続きで示します。
検証モデルや zkVM の詳細に入る前に、どの画面で何が作られ、どの時点で何を検証するのかを把握するための入口です。

## 画面と API の対応

| 順序 | 画面 / 状態     | 主な API                                                                      | 役割                                                                  |
| ---- | --------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1    | Home            | `POST /api/session`                                                           | セッション、capability token、選挙設定の識別子を作る                  |
| 2    | Vote            | `POST /api/vote`                                                              | 投票コミットメントを送信し、投票レシートと掲示板上の位置を受け取る    |
| 3    | Bot progress    | `GET /api/progress`                                                           | デモ用ボット投票の進捗を polling する                                 |
| 4    | Aggregate       | `POST /api/finalize`                                                          | 集計、zkVM 実行、監査用アーティファクト生成を要求する                 |
| 5    | Async status    | `GET /api/sessions/:sessionId/status`                                         | 非同期 finalization の pending / running / succeeded 状態を確認する   |
| 6    | Result          | `GET /api/sessions/:sessionId/status`, `POST /api/verification/run`           | finalization output を表示し、必要なら STARK verification を開始する  |
| 7    | Verify          | `GET /api/verify`, `POST /api/verification/run`                               | 検証ペイロードを取得し、未開始なら STARK verification を開始する      |
| 8    | Bundle / report | `GET /api/verification/bundles/:sessionId/:executionId`（および同 `/report`） | capability 保護 API から public bundle と protected report を取得する |

通常の session-scoped API は `X-Session-ID` と `X-Session-Capability` で保護されます。
`GET /api/sessions/:sessionId/status` と bundle / report 取得 API は path で session を指しますが、session capability の検証を通過した場合だけ現在の session に紐付く情報を返します。

## 1. Home

Home で開始すると、ブラウザは `POST /api/session` を送ります。
サーバーは `sessionId`、`capabilityToken`、`electionId`、`electionConfigHash`、`logId` などを返し、ブラウザはそれらをローカル session state に保存して Vote へ進みます。

この session が以後の API 呼び出しの権限境界です。
別タブや古い session が現在の session と食い違う場合、後続画面は fail-closed に扱います。

## 2. Vote と bot progress

Vote では、ブラウザが投票選択と乱数からコミットメントを作り、`POST /api/vote` に送信します。
成功すると、投票者は `voteId`、`bulletinIndex`、`bulletinRootAtCast` を含むレシート情報を受け取ります。

その後、デモ用のボット投票が進むあいだ `GET /api/progress` を polling します。
これは最終的な集計に十分な投票が揃うまでの進捗表示であり、検証の成功判定ではありません。

## 3. Aggregate と async status

Aggregate では、ユーザーが通常シナリオまたは教育用 tamper scenario を選び、`POST /api/finalize` を送ります。
この段階で、集計結果、zkVM の公開出力、receipt、`bundle.zip` 用の公開可能アーティファクトなどが作られます。

`POST /api/finalize` は同期完了する場合も、`202 Accepted` で非同期 queue に入る場合もあります。
非同期の場合、ブラウザは `GET /api/sessions/:sessionId/status` を polling し、finalization result が session に反映されるまで待ちます。

finalization と STARK receipt verification は同一ではありません。
finalization は proof material と結果を作る段階ですが、STARK verification が常にこの時点で完了しているとは限りません。

## 4. Result から Verify へ

Result は finalization output、つまり tally、scenario、journal / receipt 由来の表示材料、bundle 参照などを表示します。
ユーザーが検証へ進むと、ブラウザは STARK verification が未開始なら `POST /api/verification/run` を送ってから `/verify` へ遷移します。
この要求は terminal status まで待たず、`/verify` 側で `GET /api/verify` を polling しながら状態を解決します。

`verificationStatus` は STARK receipt verification の状態を示す信号であり、Cast-as-Intended、Recorded-as-Cast、Counted-as-Recorded を含む overall verdict そのものではありません。
UI が "Verified" を表示できるかは、全 required checks の評価と hard-failure 条件から別途導かれます。

## 5. Verify

Verify は `GET /api/verify` で検証ペイロードを取得します。
ペイロードには、投票レシート、掲示板証明、counted-as-recorded の証拠、STARK status、verification checks と steps が含まれます。

STARK verification が `not_run` または `running` の場合、Verify は必要に応じて `POST /api/verification/run` を起動し、terminal status に到達するまで `GET /api/verify` を polling します。
その後、4 段階のチェック結果から最終表示を解決します。
required check が未実行、実行中、失敗、または hard-failure に該当する場合、成功した overall verification にはなりません。

検証の詳しい評価順序は [検証パイプライン](verification/design-and-flow.md) と [ゲーティングロジック](verification/gating-logic.md) を参照してください。

## 6. Bundle と report

検証画面から取得できる `bundle.zip` は public bundle、つまり秘密を含まない公開可能アーティファクトだけを含む監査用 ZIP です。
一方、`verification.json` は検証サービスの protected report artifact であり、`bundle.zip` のメンバーではありません。

通常の取得経路はどちらも capability 保護 API です。

| API                                                            | 返すもの                                      |
| -------------------------------------------------------------- | --------------------------------------------- |
| `GET /api/verification/bundles/:sessionId/:executionId`        | public `bundle.zip`                           |
| `GET /api/verification/bundles/:sessionId/:executionId/report` | protected `verification.json` report artifact |

ここでいう `public` は「秘密を含まず第三者検証に使える」という機密性の分類であり、無認証公開を意味しません。
raw S3 URL や presigned URL は通常のブラウザ / CLI contract ではありません。
ファイル構成と除外対象は [公開境界](verification/public-boundary.md) と [バンドル構造](verification/bundle-structure.md) を参照してください。

## Receipt と proof mode の読み分け

ローカル UI 開発では mock zkVM、実装連携確認では `RISC0_DEV_MODE=1` の dev-mode receipt、本番相当の検証では production STARK proof を使います。
mock や dev-mode receipt はデモや開発速度のための経路であり、production STARK proof と同じ保証を持ちません。

このページでは利用順だけを扱います。
receipt の意味、Image ID、dev-mode の fail-closed ルールは [zkVM 設計](zkvm/index.md) と [4 段階検証モデル](verification/four-stage-model.md) を参照してください。

<!-- source: apps/web/src/routes/HomePage.tsx, apps/web/src/components/vote/VoteForm.tsx, apps/web/src/components/vote/BotVotingProgress.tsx, apps/web/src/routes/aggregate/page.tsx, apps/web/src/routes/result/page.tsx, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/hooks/useVerificationSequence.ts, apps/web/src/routes/verify/lib/download.ts, apps/api/src/server/api/routes/definitions.ts, public-book/src/overview.md, public-book/src/verification/public-boundary.md -->
