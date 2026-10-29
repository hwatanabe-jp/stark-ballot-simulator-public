# 投票記録と掲示板

サーバーは投票コミットメントを掲示板に記録し、その位置と掲示板の状態を投票レシートとして返します。コミットメントは選択肢と乱数から計算した値です。ブラウザは保存した選択肢と乱数から再計算し、サーバーが受理した記録との一致を検証します。

掲示板への記録と、その後の追記に対する整合性は、ルートハッシュと Merkle 証明で確認します。たとえば、インデックス 0 のユーザー票に 63 票が追加された場合、最初の記録が 64 票の掲示板にも残っていることを検証します。

利用者ごとに異なる掲示板を提示するスプリットビューの検出には、STH ダイジェストを別の記録源と照合します。同じサーバーの応答を再取得するだけでは、独立した確認にはなりません。

掲示板への記録と集計への採用は別に検証します。集計ゲストは掲示板のルートを受け取り、各入力票がその掲示板に含まれることを検査します。

<!-- source: packages/zkvm-contract/src/zkvm/types.ts, packages/zkvm-contract/src/zkvm/bitmap.ts, packages/merkle/src/, packages/verification/src/merkle/, packages/domain/src/lib/bulletin/, packages/verification/src/verification/sth-verifier.ts -->
