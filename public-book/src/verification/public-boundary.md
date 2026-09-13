# 公開できる証拠と、手元に残す情報

選択肢と乱数を公開すれば、第三者は一票ずつ集計をやり直せます。しかし、それでは誰かのコミットメントがどの候補への票かも分かってしまいます。そこで `bundle.zip` には、投票内容を開かずに計算や入力のつながりを確認するための証拠を収めます。

公開入力には、ゲストに渡した票のインデックス、コミットメント、Merkle パスが含まれます。個々の記録を公開監査に使う設計ですが、選択肢と乱数は収めません。なお、このデモではサーバーが投票時に選択肢と乱数を受け取ります。公開アーカイブから秘密を除くことと、運営者から秘密を隠すことは別です。

## 公開可能と、誰でもダウンロード可能の違い

本書の「公開可能」や `public` は、第三者へ渡せる内容であるというデータの分類です。無認証のダウンロードを意味しません。

ブラウザと CLI は、セッションへのアクセス権を示す capability を使って証拠を取得します。取得した `bundle.zip` を第三者へ渡し、その人が [ローカルで検証する](../reproducibility/index.md)ことができます。レポートは別の保護対象で、ZIP と同じ公開範囲には含めません。

## bundle.zip に入れないファイル

| ファイル               | 保護する理由                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `input.json`           | ゲストの秘密入力。投票の選択肢と乱数を含み得る                                   |
| `verification.json`    | 検証サービスの完全なレポート。公開 ZIP に同梱せず、専用の認証付き API で取得する |
| `included-bitmap.json` | どのインデックスを計上したかを表す完全なビットマップ                             |
| `seen-bitmap.json`     | どのインデックスをゲストへ提示したかを表す完全なビットマップ                     |
| `failure-marker.json`  | 非同期プローバーが失敗時に残す、限定された失敗分類の内部診断情報                 |

最初の四つは同期・非同期のどちらでも保護対象です。`failure-marker.json` は非同期実行時だけ生成され得る診断用ファイルで、レポートの取得 API からも配布しません。

ビットマップのファイル全体は ZIP に含めず、画面は自票の位置について証明を取得します。ただし、その証明には自票を含む 32 バイトの区画が入ります。このデモの全 64 位置は同じ区画に収まるため、他の位置の採用・提示状況も読み取れます。通常の API は証明の対象インデックスをそのセッションのユーザー票に限定しますが、区画内の他のビットを隠すものではありません。完全なビットマップや投票時の手元データが ZIP にないため、ZIP 単体では検証画面の最終判定を完全には再現できません。

## 許可したファイルだけを収める

新しい内部ファイルが増えたとき、それが自動的に ZIP へ入ると、秘密の公開につながります。そのため、アーカイブの構成は一つのマニフェストで明示します。登録されていないファイルは、既定で非公開です。同期・非同期それぞれの正確なメンバーは [バンドル構造](bundle-structure.md)に示します。

生成処理はファイル一覧を選ぶだけでなく、完成した ZIP を検査します。必須ファイルの欠落、保護対象・未知のファイル、同名重複、大文字小文字だけが違う衝突、絶対パス、親ディレクトリへの移動、正規の名前でないエントリを拒否します。同期・非同期の公開前にこの規則を適用し、ローカル配信時にもアーカイブ全体を再検査します。

S3 配信では、公開前に検査済みのオブジェクトを読み出します。配信時に ZIP を再解析する代わりに、HEAD で固定した同一オブジェクト表現に結びつけて全体または範囲のバイト列を返します。

## bundle と report の取得経路

| API                                                                           | 内容                           |
| ----------------------------------------------------------------------------- | ------------------------------ |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle` | 公開可能な `bundle.zip`        |
| `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report` | 保護対象の `verification.json` |

どちらもセッション capability と、現在成功済みの集計に一致する `finalizationId` が必要です。API が権限と対象を確認してから、選択されたローカル保存先または S3 を読みます。利用者への通常配信には、生の S3 URL や署名付き URL を使いません。

大きい ZIP は同じ API のバイト範囲取得でダウンロードします。保存先に対象がない場合は別の保存方式を探しに行かず、取得失敗として返します。HTTP の範囲取得とエラーの契約は [API エンドポイント](../api/endpoints.md#artifact-取得-api)に示します。

<!-- source: packages/verification/src/verification/public-bundle-manifest.json, packages/verification/src/verification/public-bundle-manifest.ts, packages/verification/src/verification/verification-bundle.ts, packages/aws-adapters/src/finalize/async-prover-artifacts.ts, infra/docker/entrypoint.sh, infra/docker/prover-failure-marker-contract.json, apps/api/src/server/api/handlers/verificationBundles.ts, docs/verification/README.md -->
