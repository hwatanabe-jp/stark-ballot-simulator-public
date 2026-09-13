# 投票して、結果を確かめる

最初は改ざんのない通常シナリオ **S0** で、B に一票を入れてみます。操作は「開始する → 投票する → 集計する → 検証する」の順です。

## 投票する

Home で開始すると、自分用のセッションが作られます。Vote 画面で A〜E から B を選んで送信すると、投票レシートが返ります。レシートには、票を識別する値と掲示板上の位置が記録されています。このデモでは自分の票はインデックス 0 に置かれます。

ブラウザは、選択した B と、その投票用に作った乱数を手元に残します。あとで「返ってきたレシートは、確かに自分が送った票のものか」を確認するためです。続いて 63 票のボット投票が加わり、進捗表示が完了すると集計へ進めます。

セッションのデータを取得するための鍵もブラウザに保存されます。この鍵が capability token です。別のセッションのデータを取り違えたり、鍵を失ったりした場合は検証に必要な情報を取得できません。

## 集計する

Aggregate 画面で S0 を選び、集計を開始します。サーバーは票を数えるとともに、どの入力からどの結果を得たかを示す証拠を作ります。この一連の作業を **集計確定（finalization）** と呼びます。

集計プログラムを実行したことを、あとから確かめられる暗号学的な証拠が **STARK 証明**です。AWS 上でこの証明を作る場合は時間がかかるため、画面で完了を待ちます。ブラウザはサーバーへ定期的に進捗を問い合わせます。成功すると Result 画面へ進み、候補ごとの得票数を表示します。失敗やタイムアウトであれば、結果の成功として扱いません。

ここで得られたのは、集計結果と検証用の材料です。まだ結果の数字だけを信用する必要はありません。

## 検証する

Result から Verify へ進むと、票の記録、集計への反映、計算の証明を確かめます。証明を運ぶデータを **STARK レシート**と呼びます。その検証が未開始なら開始し、実行中は結果を待ちます。ブラウザに残した投票時の情報も、この段階で使います。

画面の **Verified** は、必要なチェックがすべて通った場合にだけ表示できます。実行中や証拠不足ならその状態を示し、データが食い違えば失敗を示します。計算の証明だけが成功しても、投票者の票が抜けていれば全体の成功にはなりません。

S0 でも、第三者が観測する掲示板との照合先を設定していない場合は Warning（制限付き）になります。改ざんを見つけたという意味ではなく、その外部照合を行っていないことを示します。

ローカル開発用の `pnpm dev` では、証明の代わりに動作確認用の代替データ（mock）を使います。また、実際の zkVM を動かしていても開発用レシートを使う構成があります。これらは画面や処理の動作を試すためのもので、本番用の STARK 証明と同じ成功表示にはしません。

## 票を抜いたら、何が起きるか

通常の流れを確認できたら、新しいセッションで **S1** を選んでみます。S1 は、自分の票を掲示板には残したまま、集計プログラムに渡す入力から抜くシナリオです。

この場合、掲示板に票があることは確認できても、集計に反映されたことは確認できません。「記録されている」と「数えられている」が別々のチェックになっている理由を、画面上で確かめられます。他の変更も [改ざんシナリオ](tamper/scenarios.md) で試せます。

## 証拠を持ち帰る

検証画面から `bundle.zip` をダウンロードできます。中には計算の証明と、公開して照合できる入力・出力が入っています。サーバーの検証結果に頼らず、自分の環境で証明を検証するための材料です。

ダウンロードにはセッションの鍵が必要ですが、ZIP の中身は第三者に渡せるよう秘密情報を除いてあります。検証サービスのレポート `verification.json` は別ファイルとして取得し、ZIP には含めません。実行手順は [手元で証拠を検証する](reproducibility/audit-bundle.md) に続きます。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/finalizations.ts, packages/api-contract/src/schemas/verification.ts, packages/runtime-config/src/env/runtimeProfile.ts, apps/web/src/api/client.ts, apps/web/src/api/finalizations.ts, apps/web/src/api/verification.ts, apps/web/src/api/artifacts.ts, apps/web/src/routes/HomePage.tsx, apps/web/src/components/vote/VoteForm.tsx, apps/web/src/components/vote/BotVotingProgress.tsx, apps/web/src/routes/aggregate/page.tsx, apps/web/src/routes/result/page.tsx, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/hooks/useVerificationSequence.ts, apps/web/src/routes/verify/hooks/useVerificationObservation.ts, public-book/src/verification/public-boundary.md -->
