# 公開証拠と非公開情報

`bundle.zip` は、第三者が計算結果と入力の対応を検証するための証拠です。公開入力にはゲストに渡した票のインデックス、コミットメント、Merkle パスを収め、選択肢と乱数を除きます。選択肢と乱数を公開すると、第三者が一票ずつ再集計できる一方、各コミットメントがどの候補への票かも分かるためです。

この秘匿の対象は公開アーカイブの受領者です。デモのサーバーは投票時に選択肢と乱数を受け取るため、運営者に対する秘匿は保証しません。

## 公開可能と、誰でもダウンロード可能の違い

本書の「公開可能」や `public` は、第三者へ渡せる内容であるというデータの分類です。取得には認証が必要で、ブラウザと CLI はセッションへのアクセス権を示す capability を使います。

取得した `bundle.zip` は第三者へ渡し、その人が [ローカルで検証する](../reproducibility/index.md)ことができます。レポートは ZIP と別の保護対象で、専用の認証付き API から取得します。

## bundle.zip に入れないファイル

| ファイル               | 保護する理由                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `input.json`           | ゲストの秘密入力。投票の選択肢と乱数を含み得る                                   |
| `verification.json`    | 検証サービスの完全なレポート。公開 ZIP に同梱せず、専用の認証付き API で取得する |
| `included-bitmap.json` | どのインデックスを計上したかを表す完全なビットマップ                             |
| `seen-bitmap.json`     | どのインデックスをゲストへ提示したかを表す完全なビットマップ                     |
| `failure-marker.json`  | 非同期プローバーが失敗時に残す、限定された失敗分類の内部診断情報                 |

最初の四つは同期・非同期のどちらでも保護対象です。`failure-marker.json` は非同期実行時だけ生成され得る診断用ファイルで、レポートの取得 API からも配布しません。

画面は、そのセッションのユーザー票を対象インデックスとしてビットマップ証明を取得します。証明には自票を含む 32 バイトの区画が入り、このデモの全 64 位置が同じ区画に収まるため、他の位置の採用・提示状況も読み取れます。API による対象インデックスの制限は、区画内の他のビットを隠すものではありません。

ZIP には完全なビットマップや投票時の手元データがないため、ZIP 単体では検証画面の最終判定を完全には再現できません。

## 許可したファイルだけを収める

内部ファイルの追加によって秘密情報が公開されないよう、アーカイブに含めるファイルを一つのマニフェストで指定します。登録されていないファイルは、既定で非公開です。同期・非同期それぞれの正確なメンバーは [バンドル構造](bundle-structure.md)に示します。

生成処理はファイル一覧を選ぶだけでなく、完成した ZIP を検査します。必須ファイルの欠落、保護対象・未知のファイル、同名重複、大文字小文字だけが違う衝突、絶対パス、親ディレクトリへの移動、正規の名前でないエントリを拒否します。同期・非同期の公開前にこの規則を適用し、ローカル配信時にもアーカイブ全体を再検査します。

S3 配信では、公開前に検査済みのオブジェクトを読み出します。配信時に ZIP を再解析する代わりに、HEAD で固定した同一オブジェクト表現に結びつけて全体または範囲のバイト列を返します。

## bundle と report の取得経路

| API                                                                           | 内容                           |
| ----------------------------------------------------------------------------- | ------------------------------ |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle` | 公開可能な `bundle.zip`        |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report` | 保護対象の `verification.json` |

どちらもセッション capability と、現在成功済みの集計に一致する `finalizationId` が必要です。API が権限と対象を確認してから、選択されたローカル保存先または S3 を読みます。利用者への通常配信には、生の S3 URL や署名付き URL を使いません。

大きい ZIP は同じ API のバイト範囲取得でダウンロードします。保存先に対象がない場合は別の保存方式へ切り替えず、取得失敗として返します。HTTP の範囲取得とエラー応答の仕様は [API エンドポイント](../api/endpoints.md#artifact-取得-api)に示します。

<!-- source: packages/verification/src/verification/public-bundle-manifest.json, packages/verification/src/verification/public-bundle-manifest.ts, packages/verification/src/verification/verification-bundle.ts, packages/aws-adapters/src/finalize/async-prover-artifacts.ts, infra/docker/entrypoint.sh, infra/docker/prover-failure-marker-contract.json, apps/api/src/server/api/handlers/verificationBundles.ts, docs/verification/README.md -->
