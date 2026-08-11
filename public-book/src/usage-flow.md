# 利用フロー

このページは、ブラウザでの通常利用順と、その裏で使われる API を一続きで示します。
検証モデルや zkVM の詳細に入る前に、どの画面で何が作られ、どの時点で何を検証するのかを把握するための入口です。

## 画面と API の対応

| 順序 | 画面 / 状態     | 主な操作                                                                                                                                                                                                                                                                                                                      | 役割                                                                                |
| ---- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Home            | [セッション作成](api/endpoints.md#post-apisessions)                                                                                                                                                                                                                                                                           | セッション、capability token、選挙設定の識別子を作る                                |
| 2    | Vote            | [投票送信](api/endpoints.md#post-apisessionssessionidvotes)                                                                                                                                                                                                                                                                   | 投票コミットメントを送信し、投票レシートと掲示板上の位置を受け取る                  |
| 3    | Bot progress    | [ボット投票進捗](api/endpoints.md#get-apisessionssessionidprogress)                                                                                                                                                                                                                                                           | デモ用ボット投票の進捗をポーリングする                                              |
| 4    | Aggregate       | [集計/証明生成](api/endpoints.md#post-apisessionssessionidfinalizations)                                                                                                                                                                                                                                                      | 集計、zkVM 実行、監査用アーティファクト生成を要求する                               |
| 5    | Async status    | [current finalization 取得](api/endpoints.md#get-apisessionssessionidfinalizationscurrent)                                                                                                                                                                                                                                    | current finalization の pending / running / succeeded / failed / timeout を確認する |
| 6    | Result          | [current finalization 取得](api/endpoints.md#get-apisessionssessionidfinalizationscurrent)、[STARK 検証実行](api/endpoints.md#post-apisessionssessionidfinalizationsfinalizationidverification)                                                                                                                               | finalization output を表示し、必要なら STARK verification を開始する                |
| 7    | Verify          | [検証 resource 取得](api/endpoints.md#get-apisessionssessionidfinalizationsfinalizationidverification)、[STARK 検証実行](api/endpoints.md#post-apisessionssessionidfinalizationsfinalizationidverification)、[cast 観測の記録](api/endpoints.md#post-apisessionssessionidfinalizationsfinalizationidverificationobservations) | 検証ペイロードの取得、STARK verification の開始、非 gating の観測記録を行う         |
| 8    | Bundle / report | [バンドル ZIP 取得](api/endpoints.md#get-apisessionssessionidfinalizationsfinalizationidartifactsbundle)、[検証レポート取得](api/endpoints.md#get-apisessionssessionidfinalizationsfinalizationidartifactsreport)                                                                                                             | capability 保護 API から public `bundle.zip` と protected report を取得する         |

正確な path、request/response schema、公開エラーは [エンドポイント一覧](api/endpoints.md) を参照してください。

`POST /api/sessions` を除く session-scoped API は、path の `:sessionId` と `X-Session-Capability` ヘッダーだけで現在の session を特定して保護します。
finalization、verification、bundle / report の resource は path の `:finalizationId` にも結び付けられ、session capability と一致した場合だけ返されます。
ヘッダー要件の詳細は [エンドポイント一覧 > 共通 contract](api/endpoints.md#共通-contract) を参照してください。

## 1. Home

Home で開始すると、ブラウザは `POST /api/sessions` を送ります。
サーバーは `sessionId`、`capabilityToken`、`electionId`、`electionConfigHash`、`logId` などを返し、ブラウザはそれらをローカル session state に保存して Vote へ進みます。

この session が以後の API 呼び出しの権限境界です。
別タブや古い session が現在の session と食い違う場合、後続画面は fail-closed に扱います。

## 2. Vote と bot progress

Vote では、ブラウザが投票選択と乱数からコミットメントを作り、`POST /api/sessions/:sessionId/votes` に送信します。
成功すると、投票者は `voteId`、`bulletinIndex`、`bulletinRootAtCast` を含む投票レシートを受け取ります。

その後、デモ用のボット投票が進むあいだ `GET /api/sessions/:sessionId/progress` をポーリングします。
これは最終的な集計に十分な投票が揃うまでの進捗表示であり、検証の成功判定ではありません。

## 3. Aggregate と async status

Aggregate では、ユーザーが通常シナリオまたは教育用 tamper scenario を選び、`POST /api/sessions/:sessionId/finalizations` を送ります。
この段階で、集計結果、zkVM の公開出力、receipt、`bundle.zip` 用の公開可能アーティファクトなどが作られます。

finalization 作成要求は同期結果を返す場合も、`202 Accepted` で非同期 queue に入る場合もあります。
非同期の場合、ブラウザは `GET /api/sessions/:sessionId/finalizations/current` をポーリングします。
current finalization resource は `pending`、`running`、`succeeded`、`failed`、`timeout` のいずれかであり（status ごとのフィールドは [エンドポイント一覧 > Finalization resource](api/endpoints.md#finalization-resource)）、ブラウザは `succeeded` の result だけを Result へ引き継ぎ、`failed` と `timeout` は失敗として扱います。

finalization と STARK receipt verification は同一ではありません。
finalization は proof material と結果を作る段階ですが、STARK verification が常にこの時点で完了しているとは限りません。

## 4. Result から Verify へ

Result は current finalization resource の succeeded result から、tally、scenario、journal / receipt 由来の表示材料などを表示します。
finalization response のアーティファクト情報は `available` / `unavailable` の bounded availability であり、raw locator やダウンロード URL ではありません。

ユーザーが検証へ進むと、ブラウザは STARK verification が未開始なら `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification` を送ってから `/verify` へ遷移します。
この要求は terminal status まで待たず、`/verify` 側で同じ finalization-scoped resource を `GET` でポーリングしながら状態を解決します。

verification POST 応答の `verificationStatus` と、available な verification GET resource の
`verifierResult.status` は STARK receipt verification の状態を示す信号であり、Cast-as-Intended、
Recorded-as-Cast、Counted-as-Recorded を含む overall verdict そのものではありません。
UI が "Verified" を表示できるかは、全 required checks の評価と hard-failure 条件から別途導かれます。

## 5. Verify

Verify は `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification` で検証ペイロードを取得します。
resource は `available`、`unavailable`、`corrupt` を明示します。`available` の場合は
`proofAuthority`、`presentation`、`verifierResult`、`verification.checks` / `verification.steps`、
`voterEvidence`、journal の included / omitted discriminator を返します。投票レシートと自票 proof は
`voterEvidence.availability = "available"` の場合だけ存在し、それ以外は理由を伴って unavailable になります。

STARK verification が `not_run` の場合、Verify は同じ finalization-scoped verification resource への
`POST` を一度起動します。`not_run` または `running` の間は、terminal status に到達するまで `GET` をポーリングします。
その後、4 段階のチェック結果から最終表示を解決します。
required check が未実行、実行中、失敗、または hard-failure に該当する場合、成功した overall verification にはなりません。

server-validated な検証シーケンスが terminal status まで完了すると、ブラウザは `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations` で Cast-as-Intended の観測結果を best-effort に記録します。
これは telemetry であり、送信の成否が画面の verdict を変更することはありません。

検証の詳しい評価順序は [検証パイプライン](verification/design-and-flow.md) と [ゲーティングロジック](verification/gating-logic.md) を参照してください。

## 6. Bundle と report

検証画面から取得できる `bundle.zip` は、秘密を含まない公開可能アーティファクトだけを含む監査用 ZIP です。
一方、`verification.json` は検証サービスの protected report artifact であり、`bundle.zip` のメンバーではありません。

ブラウザは、検証レスポンスで admit した `finalizationId` と現在の session identity から authenticated artifact URL を組み立てます。
通常の取得経路はどちらも capability 保護 API であり、レスポンス内の raw locator をたどる方式ではありません。

| API                                                                           | 返すもの                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle` | public `bundle.zip`                           |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report` | protected `verification.json` report artifact |

ここでいう `public` は「秘密を含まず第三者検証に使える」という機密性の分類であり、無認証公開を意味しません。
ファイル構成と除外対象は [公開境界](verification/public-boundary.md) と [バンドル構造](verification/bundle-structure.md) を参照してください。

## Receipt と proof mode の読み分け

ローカル UI 開発では `local-demo` の mock zkVM、実装連携確認では `local-proof-development` の development receipt、本番相当の検証では `local-proof-production` または target runtime の production STARK proof を使います。
mock や dev-mode receipt はデモや開発速度のための経路であり、production STARK proof と同じ保証を持ちません。

このページでは利用順だけを扱います。
receipt の意味、Image ID、dev-mode の fail-closed ルールは [zkVM 設計](zkvm/index.md) と [4 段階検証モデル](verification/four-stage-model.md) を参照してください。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/finalizations.ts, packages/api-contract/src/schemas/verification.ts, packages/runtime-config/src/env/runtimeProfile.ts, apps/web/src/api/client.ts, apps/web/src/api/finalizations.ts, apps/web/src/api/verification.ts, apps/web/src/api/artifacts.ts, apps/web/src/routes/HomePage.tsx, apps/web/src/components/vote/VoteForm.tsx, apps/web/src/components/vote/BotVotingProgress.tsx, apps/web/src/routes/aggregate/page.tsx, apps/web/src/routes/result/page.tsx, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/hooks/useVerificationSequence.ts, apps/web/src/routes/verify/hooks/useVerificationObservation.ts, public-book/src/verification/public-boundary.md -->
