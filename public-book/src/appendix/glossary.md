# 用語集

本書で使用する主要な用語を定義します。
暗号と検証の基礎用語、実装用語、運用用語に分けて掲載します。

## 暗号プリミティブ

### コミットメント（総称）

**コミットメント**：本書で「コミットメント」と書く場合、文脈に応じて次のいずれかを指します。
両者は対象とドメイン分離タグが異なるため、明示が必要な箇所では下位用語（**投票コミットメント** / **入力コミットメント**）を使います。

| 用語               | 対象                                              | ドメイン分離タグ            |
| ------------------ | ------------------------------------------------- | --------------------------- |
| 投票コミットメント | 個々の投票（選挙 ID、選択肢、乱数）の束縛         | `stark-ballot:commit\|v1.0` |
| 入力コミットメント | zkVM の公開可能入力（掲示板状態と投票一覧）の束縛 | `stark-ballot:input\|v1.0`  |

### 投票コミットメント（Vote Commitment）

**投票コミットメント**：ドメイン分離タグ、選挙 ID、投票選択肢、乱数を結合して SHA-256 でハッシュした値です。
投票内容を秘匿しつつ（隠蔽性）、後から変更できないことを保証します（束縛性）。
投票の Cast-as-Intended 検証の起点です。

詳細: [コミットメントスキーム](../protocol/commitment.md)
本文での使用: [ゲストプログラム](../zkvm/guest-program.md)、[4 段階検証モデル](../verification/four-stage-model.md)、[チェック一覧](../verification/checks-catalog.md)

### Merkle ルート（Bulletin Root）

**Merkle ルート**：掲示板上の全投票コミットメントから RFC 6962 の規則に従って計算されるハッシュ値です。
掲示板の特定時点における状態を一意に表します。
新しい投票が追加されるたびに更新されます。

### Merkle パス（Audit Path）

**Merkle パス**：特定のリーフ（投票コミットメント）からルートまでを再構成するために必要な兄弟ノードのハッシュ列です。
包含証明の構成要素であり、対数オーダーの検証コストを実現します。

### 包含証明（Inclusion Proof）

**包含証明**：特定の投票コミットメントが掲示板に含まれていることを暗号学的に証明するデータです。
リーフインデックス、監査パス、ツリーサイズから構成されます。
RFC 6962 のハッシュ規則に従い、リーフとパスからルートを再計算して期待値と照合します。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md)
本文での使用: [4 段階検証モデル](../verification/four-stage-model.md)、[ゲストプログラム](../zkvm/guest-program.md)

### 整合性証明（Consistency Proof）

**整合性証明**：RFC 6962 で定義された、2 つの時点のツリーが追記関係にあることを暗号学的に証明するデータです。
古いツリーが新しいツリーのプレフィックスであること（投票の削除や並べ替えが行われていないこと）を保証します。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md)
本文での使用: [4 段階検証モデル](../verification/four-stage-model.md)、[チェック一覧](../verification/checks-catalog.md)

### 入力コミットメント（Input Commitment）

**入力コミットメント**：zkVM が処理した公開可能な入力フィールドの一部を、固定のドメインタグと version を含む正準エンコーディングで SHA-256 ハッシュした値です。
現行実装では `electionId`、`bulletinRoot`、`treeSize`、`totalExpected`、`votesCount`、各投票の `index`、コミットメント、Merkle パスを束縛します。
対象は `public-input.json` より狭い部分集合です。

詳細: [入力コミットメント](../protocol/input-commitment.md)
本文での使用: [ゲストプログラム](../zkvm/guest-program.md)、[4 段階検証モデル](../verification/four-stage-model.md)、[チェック一覧](../verification/checks-catalog.md)

### STH ダイジェスト（Signed Tree Head Digest）

**STH ダイジェスト**：掲示板のログ ID、ツリーサイズ、タイムスタンプ、ルートハッシュを結合して SHA-256 でハッシュした値です。
特定の時点における掲示板の状態を一意に識別し、複数の独立した監視者間で掲示板の一貫性を検証するために使用します。

詳細: [STH ダイジェスト](../protocol/sth-digest.md)
本文での使用: [4 段階検証モデル](../verification/four-stage-model.md)、[ゲストプログラム](../zkvm/guest-program.md)、[チェック一覧](../verification/checks-catalog.md)

### 包含ビットマップルート（Included Bitmap Root）

**包含ビットマップルート**：zkVM ゲストが生成するビットマップ（各投票インデックスが集計に含まれたか否か）の Merkle ルートです。
投票者は自分のインデックスに対応するビットが 1 であることを Merkle 証明で確認できます。

詳細: [ビットマップ Merkle](../protocol/bitmap-merkle.md)

### 提示ビットマップルート（Seen Bitmap Root）

**提示ビットマップルート**：zkVM ゲストに提示された投票インデックスを表すビットマップの Merkle ルートです。
`includedBitmapRoot` と組み合わせることで、自票が「counted された」「提示されたが無効だった」「そもそも prover に提示されなかった」のどれに該当するかを説明できます。

詳細: [ビットマップ Merkle](../protocol/bitmap-merkle.md)

### 正準エンコーディング（Canonical Encoding）

**正準エンコーディング**：固定のドメインタグ、バージョン番号、フィールド順を含む決定論的なバイト列表現です。
同一の入力から常に同一のバイト列が得られることを保証します。
本システムではコミットメントと入力コミットメントの計算に使用します。

### ドメイン分離タグ（Domain Separation Tag）

**ドメイン分離タグ**：ハッシュ計算において異なる用途のデータが衝突しないように付与するプレフィックス文字列です。
本システムでは、コミットメント、入力コミットメント、CT Merkle のリーフハッシュ、ノードハッシュにそれぞれ固有のタグを使用します。

### 投票レシート（Vote Receipt）

**投票レシート**：投票受理時にサーバーが返す応答データです。
`voteId`、`commitment`、`bulletinIndex`、`bulletinRootAtCast` を含みます。
検証では `voteReceipt` として参照されます。
投票者がローカルに保持する投票時データ（選挙 ID、選択肢、乱数）とは別物であり、zkVM が生成する STARK レシート（Receipt）とも別物です。
Cast-as-Intended 検証では、投票時データからコミットメントを再計算し、投票レシートのコミットメント値と照合します。

詳細: [コミットメントスキーム](../protocol/commitment.md)、[4 段階検証モデル](../verification/four-stage-model.md#stage-1-cast-as-intended)
本文での使用: [チェック一覧](../verification/checks-catalog.md)、[セッションライフサイクル](../api/session-lifecycle.md)

## STARK 証明

### STARK（Scalable Transparent ARgument of Knowledge）

**STARK**：Trusted setup（信頼されたセットアップ）を必要としない暗号証明方式です。
ハッシュベースの構成により耐量子計算機性に優位があります。
本システムでは RISC Zero zkVM によって投票集計の正当性を証明するために使用します。

### RISC Zero zkVM

**RISC Zero zkVM**：RISC-V アーキテクチャ上で通常の Rust コードを実行し、その実行が正しく行われたことの STARK 証明を生成するゼロ知識仮想マシンです。
ゲストプログラムとホストプログラムから構成されます。

### レシート（Receipt）

**レシート**：zkVM が生成する暗号証明オブジェクトです。
内部に Seal（STARK 証明本体）とジャーナル（公開出力）を含みます。
`Receipt::verify(image_id)` によって、特定のゲストプログラムが正しく実行されたことを第三者が検証できます。

### ジャーナル（Journal）

**ジャーナル**：zkVM ゲストプログラムの公開出力です。
現行契約は `methodVersion=14` で、検証済み集計結果、`missingSlots` / `invalidPresentedSlots` / `excludedSlots`、`inputCommitment`、`includedBitmapRoot`、`seenBitmapRoot` などを含みます。
レシートに暗号学的に束縛されており、改ざんできません。

### Image ID

**Image ID**：コンパイル済みのゲストプログラムバイナリを一意に識別するハッシュ値です。
レシート検証時に期待される Image ID と照合することで、意図したゲストプログラムによって生成された証明であることを確認します。
プローバーイメージの更新時には同期して更新が必要です。

詳細: [Image ID](../zkvm/image-id.md)
本文での使用: [チェック一覧](../verification/checks-catalog.md)、[検証サービス](../zkvm/verifier-service.md)、[イメージ署名](../aws/image-signing.md)

### ゲストプログラム（Guest Program）

**ゲストプログラム**：zkVM 内部で実行される Rust プログラムです。
投票データの検証と集計を行い、結果をジャーナルとして出力します。
ゲストの実行内容は STARK 証明によって保証されます。

### ホストプログラム（Host Program）

**ホストプログラム**：zkVM の外部で動作し、ゲストプログラムの実行と証明生成を制御する Rust プログラムです。
入力データの読み込み、zkVM の起動、レシートとジャーナルの出力を担います。

### 検証サービス（Verifier Service）

**検証サービス**：Rust で実装された独立した STARK レシート検証プログラムです。
`Receipt::verify(expected_image_id)` を実行し、レシートの暗号学的正当性を確認します。
結果は `verification.json` として保存されます。

詳細: [検証サービス](../zkvm/verifier-service.md)

### フェイクレシート（Fake Receipt）

**フェイクレシート**：`RISC0_DEV_MODE=1` で生成される暗号学的保証のないレシートです。
開発効率のためのモックであり、検証サービスは `InnerReceipt::Fake` を自動検出して `dev_mode` ステータスを返します。
本番環境では使用してはなりません。

### ジャーナル契約（Journal Contract）

**ジャーナル契約**：`methodVersion` で識別されるジャーナル出力構造の仕様です。
ゲストプログラムが出力するフィールドの集合と意味を定義します。
現行契約は `methodVersion=14`（v1.4）です。
ゲストプログラムの変更は新しい Image ID の生成を伴い、検証時には期待 Image ID との一致が確認されます。

### レシートラッパー JSON

**レシートラッパー JSON**：ホストバイナリが出力する `{ "receipt": ..., "image_id": "0x..." }` 形式のラッパー JSON です。
STARK レシート本体を `image_id` と一緒に運ぶための受け渡し形式で、検証サービスはこの形式を読み込んで `Receipt::verify(expected_image_id)` を実行します。
配布対象アーカイブ内のファイル名は `receipt.json` です。
本書では「レシート」「STARK レシート」「`receipt.json`」「レシートラッパー JSON」を次のように使い分けます。

| 表記                          | 指すもの                                 |
| ----------------------------- | ---------------------------------------- |
| 投票レシート（`voteReceipt`） | サーバーが投票受理時に返す応答データ     |
| STARK レシート（Receipt）     | zkVM が生成する暗号証明オブジェクト      |
| `receipt.json`                | レシートラッパー JSON のファイル名       |
| レシートラッパー JSON         | `{ receipt, image_id }` 構造のホスト出力 |

詳細: [ホストと証明生成](../zkvm/host-and-proving.md#出力ファイル)
本文での使用: [検証サービス](../zkvm/verifier-service.md)、[バンドル構造](../verification/bundle-structure.md)

## 検証パイプライン

> **「検証」と「監査」の使い分け**
> 本書では、`/verify` 画面と内部パイプラインによる判定を **検証**、第三者が `bundle.zip` をローカルに取得して独立に行う確認作業を **監査** と呼び分けます。
> `reproducibility/` 章は主に「監査」の文脈で書かれており、`verification/` 章は「検証」の文脈で書かれています。

### fail-closed

**fail-closed**：`/api/verify` と検証パイプラインが、データ不在や未解決状態を成功側に倒さず、`not_run`、失敗、Warning 側へ確定させる方針です。
要求された証拠が揃わない限り Verified に到達させない設計姿勢を指します。
[cast-time 証跡](#cast-time-証跡cast-time-ct-artifact)の `not_run` 扱い、[ゲーティングロジックの不変条件](../verification/gating-logic.md#不変条件のまとめ)、[重要度](#重要度criticality)の required 扱いは、いずれもこの方針の具体化です。

本文での使用: [ゲーティングロジック](../verification/gating-logic.md)、[設計と流れ](../verification/design-and-flow.md)、[チェック一覧](../verification/checks-catalog.md)

### E2E 検証可能投票（End-to-End Verifiable Voting）

**E2E 検証可能投票**：投票者が自分の投票について「意図通りに投じた」「正しく記録された」「正しく集計された」の 3 段階を独立に検証できる投票方式です。
システム運営者を信頼せずとも投票の完全性を確認できることを目標とします。

### Cast-as-Intended（意図通りの投票）

**Cast-as-Intended**：検証の第 1 段階です。
投票者がローカルに保持する投票時データ（選挙 ID、選択肢、乱数）からコミットメントを再計算し、投票レシート（`voteReceipt`）のコミットメント値と照合します。
これにより、投票時に意図した選択が正しくコミットメントに反映されたことを確認します。
クライアント側で完結します。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-1-cast-as-intended)
本文での使用: [コミットメントスキーム](../protocol/commitment.md)、[チェック一覧](../verification/checks-catalog.md)

### Recorded-as-Cast（記録通りの保存）

**Recorded-as-Cast**：検証の第 2 段階です。
コミットメントが掲示板に正しく記録されたことを、RFC 6962 の包含証明と整合性証明によって確認します。
掲示板が追記専用であること（投票が削除や改変を受けていないこと）を暗号学的に保証します。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-2-recorded-as-cast)
本文での使用: [CT Merkle ツリー](../protocol/ct-merkle.md)、[チェック一覧](../verification/checks-catalog.md)

### cast-time 証跡（Cast-Time CT Artifact）

**cast-time 証跡**：投票受理時に CT ツリーへ書き込んだ時点の証跡です。
具体的には `voteReceipt`（投票レシート）と `userVote.proof`（包含証明パラメータ: `leafIndex`、`treeSize`、`auditPath`）の 2 つを指します。
Recorded-as-Cast の検証では両方が必要です。
Cast-as-Intended では `voteReceipt` のみを使用します。
`/api/verify` は store から再構成できた場合にだけこれらを返し、再構成できない場合は関連チェックを `not_run` として fail-closed に扱います。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-2-recorded-as-cast)

### Counted-as-Recorded（記録通りの集計）

**Counted-as-Recorded**：検証の第 3 段階です。
掲示板に記録された全投票が zkVM の集計に過不足なく含まれたことを確認します。
除外されたスロットがないこと（`excludedSlots == 0`）は最重要不変条件です。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-3-counted-as-recorded)
本文での使用: [入力コミットメント](../protocol/input-commitment.md)、[ビットマップ Merkle](../protocol/bitmap-merkle.md)、[チェック一覧](../verification/checks-catalog.md)

### STARK 検証（STARK Verification）

**STARK 検証**：検証の第 4 段階です。
STARK レシートが暗号学的に正当であること、および期待される Image ID で生成されたことを確認します。
ジャーナルの内容が正しい実行結果であることの最終的な保証です。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-4-stark-verification)
本文での使用: [検証サービス](../zkvm/verifier-service.md)、[Image ID](../zkvm/image-id.md)、[チェック一覧](../verification/checks-catalog.md)

### 検証チェック（Verification Check）

**検証チェック**：検証パイプラインを構成する個別の原子的な検証項目です。
現行実装では 22 個のチェックがあり、それぞれ一意の ID、所属する検証段階、証拠種別、重要度を持ちます。
Counted-as-Recorded には `counted_election_manifest_consistent` と `counted_close_statement_consistent` も含まれ、公開監査アーティファクトとの整合も required 条件です。

詳細: [チェック一覧](../verification/checks-catalog.md)
本文での使用: [設計と流れ](../verification/design-and-flow.md)、[ゲーティングロジック](../verification/gating-logic.md)

### ゲーティングロジック（Gating Logic）

**ゲーティングロジック**：検証チェックの結果を集約し、「Verified」「Verification Failed」「Warning」のいずれを表示するかを決定するロジックです。
required 扱いのチェックが 1 つでも `failed` なら Verified は表示されず、`not_run` / `pending` / `running` や必須証拠欠落でも Verified にはなりません。
Stage のステータスも、その Stage で required 扱いになるチェック群全体から導出されます。

詳細: [ゲーティングロジック](../verification/gating-logic.md)
本文での使用: [設計と流れ](../verification/design-and-flow.md)、[チェック一覧](../verification/checks-catalog.md)

### 公開監査アーティファクト

**公開監査アーティファクト**：`election-manifest.json`（選挙設定の公開監査用スナップショット）と `close-statement.json`（集計締切時点のログ境界を表す公開監査レコード）の総称です。
Counted-as-Recorded 段階の必須チェック（`counted_election_manifest_consistent`、`counted_close_statement_consistent`）で整合性が検証されます。

詳細: [チェック一覧](../verification/checks-catalog.md)、[バンドル構造](../verification/bundle-structure.md)

### 公開可能アーティファクト

**公開可能アーティファクト**：秘密データを含まず、第三者検証や監査に利用できるアーティファクトの機密性区分です。
ここでの「公開可能」は無認証で取得できることを意味しません。
通常の配布や取得は capability 保護 API が担当し、対象が S3 にある場合も API が読み出して返します。

詳細: [公開境界](../verification/public-boundary.md#public-bundle-の許可リスト)、[バンドル構造](../verification/bundle-structure.md#公開境界の要約)

### 配布対象アーカイブ（`bundle.zip`）

**配布対象アーカイブ**：公開許可リストに基づいて作成される ZIP アーカイブです。
[証明バンドル](#証明バンドルproof-bundle) のうち公開可能アーティファクトだけを束ねた部分集合で、`bundle.zip` というファイル名で配布されます。
現行構成は `public-input.json`、`election-manifest.json`、`close-statement.json`、`receipt.json`、`journal.json` などを含みます。
`input.json`、`verification.json`、`included-bitmap.json`、`seen-bitmap.json` は含まれません。
`bundle.zip` が公開可能アーティファクトだけを含むことは、無認証公開を意味しません。

詳細: [バンドル構造](../verification/bundle-structure.md)
本文での使用: [第三者検証ガイド](../reproducibility/audit-bundle.md)、[ホストと証明生成](../zkvm/host-and-proving.md)

### 保護された検証レポート（`verification.json`）

**保護された検証レポート**：サーバー側検証の詳細結果を記録する protected report artifact です。
配布対象アーカイブ `bundle.zip` には含まれず、通常のブラウザ / CLI 契約では capability 保護された `/api/verification/bundles/:sessionId/:executionId/report` から API レスポンスとして取得します。

詳細: [エンドポイント一覧](../api/endpoints.md#get-apiverificationbundlessessionidexecutionidreport)

### 無認証公開

**無認証公開**：セッション ID や capability トークンなしで誰でも取得できる公開状態です。
本書では「公開可能」や「外部クライアント向け API」と区別して扱います。
現行のセッションスコープ API や `bundle.zip` 取得経路の多くは capability 保護されており、無認証公開ではありません。

詳細: [バンドル構造](../verification/bundle-structure.md#バンドルのアクセス方法)

### zkGate

**zkGate**：STARK 検証の結果に基づいて Counted-as-Recorded チェックの評価を制御するゲートです。
STARK 未解決（`not_run` / `running`）の間、zkGate 対象チェックは `not_run` または `pending` になります。
STARK が `failed` の場合、zkGate 対象チェックも `failed` になり得ます。

詳細: [ゲーティングロジック](../verification/gating-logic.md#zkgate-stark-結果に基づく-counted-チェックの制御)

### 証拠種別

**証拠種別**：検証チェックに使用するデータの出所を示す分類です。
`local`（投票時に確定したユーザー固有データ）、`public`（掲示板や capability 保護 API から取得する、秘密データを含まない検証用データ）、`zk`（zkVM ジャーナルに含まれるデータ）、`demo`（教育用シミュレーション由来データ）の 4 種別があります。

### 重要度（Criticality）

**重要度**：検証チェックの必須性を示す分類です。
`required`（失敗、未実行、未解決なら Verified をブロック）と `optional`（補助的で、単独では Verified をブロックしない）の 2 段階です。
`recorded_sth_third_party` のように、設定状況に応じて optional から blocking な required 相当に昇格するチェックもあります。

詳細: [ゲーティングロジック](../verification/gating-logic.md)、[チェック一覧](../verification/checks-catalog.md)

## 掲示板と透明性

### 掲示板（Public Bulletin Board）

**掲示板**：全投票コミットメントを時系列で記録する追記専用のログです。
RFC 6962 の Certificate Transparency モデルに基づき、包含証明と整合性証明によって第三者が監査可能な透明性を実現します。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md)
本文での使用: [STH ダイジェスト](../protocol/sth-digest.md)、[4 段階検証モデル](../verification/four-stage-model.md)、[ゲストプログラム](../zkvm/guest-program.md)

### RFC 6962

**RFC 6962**：Certificate Transparency（証明書の透明性）の標準規格です。
追記専用の Merkle ツリー、リーフハッシュ（`0x00` プレフィックス）とノードハッシュ（`0x01` プレフィックス）のドメイン分離、包含証明、整合性証明の仕様を定義します。
本システムの掲示板は、この規格のハッシュ規則と証明アルゴリズムを参照した CT スタイル実装を採用しています。

### STH（Signed Tree Head）

**STH**：掲示板の特定時点における状態の要約です。
ログ ID、ツリーサイズ、タイムスタンプ、ルートハッシュを含みます。
複数の独立したソースからの STH を比較することで、サーバーが異なるクライアントに異なるツリーを提示するスプリットビュー攻撃を検出します。

### スプリットビュー攻撃（Split-View Attack）

**スプリットビュー攻撃**：掲示板サーバーが異なるクライアントに異なるツリー状態を提示する攻撃です。
特定の投票者に対してのみ投票を除外したツリーを見せることで、不正を隠蔽しようとします。
整合性証明と STH の第三者検証によって検出されます。

### ルート履歴（Root History）

**ルート履歴**：掲示板のルートハッシュ、ツリーサイズ、タイムスタンプの時系列記録です。
投票時のルートが最終ツリーの有効なプレフィックスであることを、整合性証明で検証する際に参照します。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md#整合性証明consistency-proof)

## 改ざんシナリオ

### 改ざんシナリオ（Tamper Scenario）

**改ざんシナリオ**：検証システムが不正をどのように検出するかを教育的に示すシミュレーションです。
S0（正常）から S5（複合改ざん）まで 6 種類が定義されています。

詳細: [改ざんシナリオ](../tamper/scenarios.md)
本文での使用: [検出メカニズム](../tamper/detection-mechanism.md)、[チェック一覧](../verification/checks-catalog.md)

### 投票除外（Vote Exclusion）

**投票除外**：一部の投票を集計から意図的に除外する攻撃です。
zkVM ジャーナルの `excludedSlots > 0` として検出されます。
本システムの最重要不変条件により、投票除外がある場合は「Verified」を表示しません。

### 主張集計改ざん（Claimed-Tally Tampering）

**主張集計改ざん**：公開表示する集計値（claimed tally）を、zkVM が証明した実際の集計値と異なる値に書き換える攻撃の教育的シミュレーションです。
zkVM の入力、レシート、ジャーナルは正常なまま、公開表示のみを改ざんします。
`counted_tally_consistent` チェックで検出されます。

### excludedSlots

**excludedSlots**：zkVM ジャーナルに含まれる、除外されたスロットの総数です。
0 でなければなりません。
0 より大きい場合は投票の未提示または未計上が発生しており、いかなる場合も「Verified」を表示してはなりません。
`excludedSlots` が現行の authoritative な公開除外数です。
`excludedCount` は古い入力を安全側に倒すための互換フィールドとしてだけ扱います。
現行レスポンスでは `excludedCount` を新規に返しません。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-3-counted-as-recorded)、[ゲーティングロジック](../verification/gating-logic.md)

## インフラストラクチャ

### ECS Fargate

**ECS Fargate**：AWS のサーバーレスコンテナ実行環境です。
本システムでは STARK 証明生成に必要な大量のメモリ（32 GB）と CPU（16 vCPU）を提供するために使用します。
アイドル時のコストは 0 です。

詳細: [非同期プローバー](../aws/async-prover.md)

### Step Functions

**Step Functions**：AWS のワークフローオーケストレーションサービスです。
イメージ署名検証、ECS プローバー実行、コールバックの一連のフローを管理します。

### 非同期証明モード（Async Proving）

**非同期証明モード**：SQS、Step Functions、ECS Fargate の経路で STARK 証明を非同期に生成するモードです。
集計リクエスト（`POST /api/finalize`）は 202 Accepted を返し、クライアントはステータスポーリングで完了を待ちます。

### 同期証明モード（Sync Proving）

**同期証明モード**：ローカルプロセスで zkVM ホストバイナリを直接実行し、STARK 証明を同期的に生成するモードです。
開発環境で使用されます。

### イメージ署名検証（Image Signing）

**イメージ署名検証**：ECS タスクで使用するプローバーコンテナイメージが、信頼できるビルドパイプラインから生成されたことを検証する仕組みです。
AWS Signer を使用し、Step Functions のゲートとして機能します。

詳細: [イメージ署名](../aws/image-signing.md)

### 証明バンドル（Proof Bundle）

**証明バンドル**：zkVM の実行結果を検証可能な形で保存、配布するためのアーティファクト群を指す **上位概念** です。
公開可能アーティファクト（`public-input.json` など）、protected report artifact（`verification.json`）、非公開アーティファクト（`input.json`、`included-bitmap.json`、`seen-bitmap.json` など）を含み得ます。
`public` /「公開可能」は秘密情報を含まず検証に利用可能であるという機密性の分類であり、無認証公開を意味しません。

公開許可リストで取り出した部分集合が [配布対象アーカイブ](#配布対象アーカイブbundlezip) であり、それを ZIP 化したファイル名が `bundle.zip` です。
3 者の関係は次のとおりです。

```text
証明バンドル ⊃ 配布対象アーカイブ ⊃ bundle.zip（ファイル）
```

「証明バンドル」は、AWS / S3 上の隣接オブジェクトや非公開アーティファクトも含めて議論したい箇所で使います。
単に公開可能な ZIP を指す場合は `bundle.zip` または「配布対象アーカイブ」を使います。

詳細: [バンドル構造](../verification/bundle-structure.md)
本文での使用: [ホストと証明生成](../zkvm/host-and-proving.md)、[非同期プローバー](../aws/async-prover.md)、[第三者検証ガイド](../reproducibility/audit-bundle.md)

### 隣接オブジェクト（Sibling Object）

**隣接オブジェクト**：S3 上で `bundle.zip` と同じ prefix（`sessions/{sessionId}/{executionId}/`）に配置される非 bundle ファイルです。
`included-bitmap.json`、`seen-bitmap.json`、`verification.json` などを指します。
`bundle.zip` には含まれませんが、コールバック復元や capability 保護された検証レポート配信で利用されます。

詳細: [バンドル構造](../verification/bundle-structure.md#バンドルディレクトリ構造)

## セッションと API

### セッション（Session）

**セッション**：一連の投票フロー（セッション作成、投票、集計、検証）を管理する単位です。
一意の `sessionId`（UUID v4）で識別されます。
クライアント側のローカルセッション TTL は投票 / 集計中が 30 分、検証中が 24 時間です。
サーバー側の保存 TTL は store 実装と runtime config に依存します。

### 選挙（Election）

**選挙**：投票の論理的な単位です。
一意の `electionId`（UUID v4）で識別され、コミットメントのドメイン分離に使用されます。
選挙設定ハッシュ（`electionConfigHash`）が期待投票数などの設定を束縛します。

### 集計確定（Finalization）

**集計確定**：全投票の収集後に zkVM 入力を構築し、STARK 証明を生成するプロセスです。
同期モード（ローカル実行）と非同期モード（ECS Fargate）の 2 つの実行パスがあります。

### X-Session-ID

**X-Session-ID**：多くの API リクエストで付与される HTTP ヘッダーです。
セッションスコーピングに使用され、異なるセッション間のデータアクセスを防止します。
`POST /api/session` は新規セッション作成のため不要です。

### X-Session-Capability

**X-Session-Capability**：`POST /api/session` のレスポンスで返る署名付きセッショントークンを運ぶ HTTP ヘッダーです。
このヘッダーが運ぶ値を capability トークンと呼びます。
session-scoped / capability 保護 API で必須です（`POST /api/session` は新規セッション作成のため対象外）。
対象 route と必要ヘッダーの一覧は [エンドポイント一覧](../api/endpoints.md#active-browser-と-cli-api-一覧) の対応表を参照してください。

`GET /api/botdata/:id`、`GET /api/zkvm-input-hash?includeData=<truthy>`、`GET /api/debug/enable` は active public browser / CLI contract の capability 保護 API ではありません。
前 2 者は retired / private inspection surface、`/api/debug/enable` は retired debug route として扱います。

### capability 保護 API

**capability 保護 API**：セッション capability の提示を要求する API です。
多くの場合は `X-Session-Capability` を使い、ヘッダースコープの API では `X-Session-ID` も併用します。
capability 保護 API は外部クライアント向けに文書化されていても、無認証公開 API ではありません。

### Turnstile

**Turnstile**：Cloudflare が提供する CAPTCHA サービスです。
`/api/vote` と `/api/finalize` で Bot による不正アクセスを防止するために使用します。
`POST /api/session` で server-side Turnstile を要求するかどうかは実行環境の設定に依存します。
`TURNSTILE_BYPASS=1` は fail-closed で、`AWS_BRANCH` などのランタイムマーカーが明示的に非本番（`develop` / `dev`）と判定できる場合のみ有効です。

## 定数

| 定数名               | 値                          | 説明                                         |
| -------------------- | --------------------------- | -------------------------------------------- |
| `BOT_COUNT`          | 63                          | サーバーが自動生成するボット投票数           |
| `MERKLE_TREE_DEPTH`  | 6                           | Merkle ツリーの深度（2^6 = 64 リーフに対応） |
| `VOTE_CHOICES`       | A, B, C, D, E               | 投票で選択可能な選択肢                       |
| コミットドメインタグ | `stark-ballot:commit\|v1.0` | コミットメントハッシュのドメイン分離タグ     |
| 入力ドメインタグ     | `stark-ballot:input\|v1.0`  | 入力コミットメントのドメイン分離タグ         |
| リーフドメインタグ   | `stark-ballot:leaf\|v1`     | CT Merkle リーフハッシュのドメイン分離タグ   |

<!-- source: packages/zkvm-contract/src/zkvm/types.ts, packages/merkle/src/rfc6962-merkle-tree.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/verification-summary.ts, packages/verification/src/verification/consistency-verifier.ts, packages/verification/src/verification/sth-verifier.ts, packages/verification/src/verification/verification-bundle.ts, apps/api/src/server/api/handlers/bitmapProof.ts, packages/zkvm-contract/src/zkvm/bitmap.ts, packages/domain/src/shared/constants.ts, packages/domain/src/types/server.ts, packages/domain/src/types/voteStore.ts, zkvm/methods/guest/src/main.rs -->
