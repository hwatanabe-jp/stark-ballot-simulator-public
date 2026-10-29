# 基本操作

通常シナリオ S0 で投票から検証まで実行する手順です。Home、Vote、Aggregate、Result、Verify の順に操作します。S0 では改ざんを行いません。

## 投票する

Home で開始し、セッションを作成します。Vote 画面で A〜E から一つを選択して送信します。ブラウザは送信前に選択肢と投票用の乱数を保存し、投票レシートとの照合に使います。

サーバーは投票者の一票と 63 票のボット投票を保存してから、投票レシートを返します。レシートには、票を識別する値と掲示板上の位置が記録されています。投票者の票はインデックス 0 に置かれます。画面が投票完了を確認すると、自動的に集計へ進みます。

通信が途切れて応答を受け取れなかった場合は、同じ票を再送できます。ページを再読み込みしても、保存した選択と乱数を使い、すでに記録された票があれば元のレシートを受け取ります。再送時は候補を変更できません。

ブラウザには、セッションのデータへのアクセス権を示す capability token も保存されます。別のセッションのトークンを使った場合や、トークンを失った場合は、検証に必要な情報を取得できません。

## 集計する

Aggregate 画面で S0 を選び、集計を開始します。サーバーは票を数えるとともに、どの入力からどの結果を得たかを示す証拠を作ります。この一連の作業を **集計確定（finalization）** と呼びます。

集計プログラムを実行したことを、あとから確かめられる暗号学的な証拠が **STARK 証明**です。AWS 上でこの証明を作る場合は時間がかかるため、画面で完了を待ちます。ブラウザはサーバーへ定期的に進捗を問い合わせます。成功すると Result 画面へ進み、候補ごとの得票数を表示します。失敗やタイムアウトであれば、結果の成功として扱いません。

集計の完了時点では、集計結果と検証用の証拠が生成されています。結果の正しさは、次の検証操作で確認します。

## 検証する

Result から Verify へ進み、票の記録、集計への採用、計算の証明を検証します。証明を含むデータを STARK レシートと呼びます。レシートの検証が未開始なら開始し、実行中は結果を待ちます。ブラウザに保存した投票時の情報も、この段階で使います。

画面の **Verified** は、必要なチェックがすべて通った場合にだけ表示できます。実行中や証拠不足ならその状態を示し、データが食い違えば失敗を示します。計算の証明だけが成功しても、投票者の票が抜けていれば全体の成功にはなりません。

S0 でも、第三者が観測する掲示板との照合先を設定していない場合は Warning（制限付き）になります。この Warning は外部照合が未実行であることを示し、改ざんを検出した状態とは区別します。

ローカル開発用の `pnpm dev` では、証明の代わりに動作確認用の代替データ（mock）を使います。また、実際の zkVM を動かしていても開発用レシートを使う構成があります。これらは画面や処理の動作を試すためのもので、本番用の STARK 証明と同じ成功表示にはしません。

## 改ざんシナリオの実行

新しいセッションで投票し、Aggregate 画面で S1 を選択します。S1 は、投票者の票を掲示板に残したまま、集計プログラムに渡す入力から除外するシナリオです。

S1 では、掲示板への記録は確認できますが、集計への採用のチェックは失敗します。記録と集計は別々のチェックで検証します。その他の操作と検出結果は[改ざんシナリオ一覧](tamper/scenarios.md)に記載しています。

## 証拠の取得

検証画面から `bundle.zip` をダウンロードします。ZIP は計算の証明と、公開可能な入力・出力を含みます。これらを使い、サーバーの検証結果から独立してローカルで証明を検証できます。

ダウンロードには capability token が必要です。ZIP は第三者へ共有できるように秘密情報を除いています。検証サービスのレポート `verification.json` は別ファイルとして取得し、ZIP には含めません。実行手順は[ローカル監査手順（Ubuntu）](reproducibility/audit-bundle.md)を参照してください。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/finalizations.ts, packages/api-contract/src/schemas/verification.ts, packages/runtime-config/src/env/runtimeProfile.ts, apps/web/src/api/client.ts, apps/web/src/api/finalizations.ts, apps/web/src/api/verification.ts, apps/web/src/api/artifacts.ts, apps/web/src/routes/HomePage.tsx, apps/web/src/components/vote/VoteForm.tsx, apps/web/src/components/vote/BotVotingProgress.tsx, apps/web/src/routes/aggregate/page.tsx, apps/web/src/routes/result/page.tsx, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/hooks/useVerificationSequence.ts, apps/web/src/routes/verify/hooks/useVerificationObservation.ts, public-book/src/verification/public-boundary.md -->
