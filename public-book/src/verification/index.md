# 証拠をつないで結果を判定する

ここまでの証拠を集めたら、投票結果としてどんな表示を返せるでしょうか。掲示板の記録も公開入力も揃っていて、得票数に食い違いが見つからなくても、STARK の検証がまだ実行中なら結論は待つ必要があります。

証拠を取得できなかった場合と、取得した証拠が矛盾する場合も、意味が違います。前者は確認できていない状態、後者は不一致を見つけた状態です。どちらも Verified にはできませんが、利用者が次に確認すべきものは異なります。

検証画面は、各チェックの結果と実行状態を合わせて、成功、失敗、待機、証拠不足、制限付きなどを表示します。ブラウザ自身が行う投票時の照合と、サーバーが報告する掲示板・集計・STARK の確認を区別しながら、一つの結果にまとめます。

まず[四つの問いと証拠](four-stage-model.md)を実際のチェックに対応させ、その後で実行場所と表示条件を確認します。

<!-- source: packages/verification/src/verification/, apps/api/src/server/api/handlers/verify.ts, apps/api/src/server/api/handlers/verificationRun.ts, apps/api/src/server/api/handlers/verificationObservation.ts, apps/api/src/server/api/handlers/verificationBundles.ts, apps/web/src/routes/verify/, apps/web/src/routes/verify/hooks/useVerificationObservation.ts -->
