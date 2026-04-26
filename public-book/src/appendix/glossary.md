# 用語集

本書で使用する主要な用語の定義です。暗号・検証の基礎用語と実装・運用の主要用語に分けて掲載しています。

---

## 暗号プリミティブ

### コミットメント（Vote Commitment）

ドメイン分離タグ、選挙 ID、投票選択肢、乱数を結合して SHA-256 でハッシュした値。投票内容を秘匿しつつ（隠蔽性）、後から変更できないことを保証する（束縛性）。投票の Cast-as-Intended 検証の起点となる。

詳細: [コミットメントスキーム](../protocol/commitment.md)

### Merkle ルート（Bulletin Root）

掲示板上の全投票コミットメントから RFC 6962 の規則に従って計算されるハッシュ値。掲示板の特定時点における状態を一意に表現する。新しい投票が追加されるたびに更新される。

### Merkle パス（Audit Path）

特定のリーフ（投票コミットメント）からルートまでを再構成するために必要な兄弟ノードのハッシュ列。包含証明の構成要素であり、対数オーダーの検証コストを実現する。

### 包含証明（Inclusion Proof）

特定の投票コミットメントが掲示板に含まれていることを暗号学的に証明するデータ。リーフインデックス、監査パス、ツリーサイズから構成される。RFC 6962 のハッシュ規則に従い、リーフとパスからルートを再計算して期待値と照合する。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md)

### 整合性証明（Consistency Proof）

RFC 6962 で定義された、2 つの時点のツリーが追記関係にあることを暗号学的に証明するデータ。古いツリーが新しいツリーのプレフィックスであること（投票の削除・並べ替えが行われていないこと）を保証する。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md)

### 入力コミットメント（Input Commitment）

zkVM が処理した公開可能な入力フィールドの一部を、固定のドメインタグと version を含む正準エンコーディングで SHA-256 ハッシュした値。現行実装では `electionId`、`bulletinRoot`、`treeSize`、`totalExpected`、`votesCount`、各投票の `index`・コミットメント・Merkle パスを束縛し、`public-input.json` より狭い部分集合を対象とする。

詳細: [入力コミットメント](../protocol/input-commitment.md)

### STH ダイジェスト（Signed Tree Head Digest）

掲示板のログ ID、ツリーサイズ、タイムスタンプ、ルートハッシュを結合して SHA-256 でハッシュした値。特定の時点における掲示板の状態を一意に識別し、複数の独立した監視者間で掲示板の一貫性を検証するために使用する。

詳細: [STH ダイジェスト](../protocol/sth-digest.md)

### 包含ビットマップルート（Included Bitmap Root）

zkVM ゲストが生成するビットマップ（各投票インデックスが集計に含まれたか否か）の Merkle ルート。投票者は自分のインデックスに対応するビットが 1 であることを Merkle 証明で確認できる。

詳細: [ビットマップ Merkle](../protocol/bitmap-merkle.md)

### 提示ビットマップルート（Seen Bitmap Root）

zkVM ゲストに提示された投票インデックスを表すビットマップの Merkle ルート。`includedBitmapRoot` と組み合わせることで、自票が「counted された」「提示されたが無効だった」「そもそも prover に提示されなかった」のどれかを説明できる。

詳細: [ビットマップ Merkle](../protocol/bitmap-merkle.md)

### 正準エンコーディング（Canonical Encoding）

固定のドメインタグ・バージョン番号・フィールド順を含む決定論的なバイト列表現。同一の入力から常に同一のバイト列が得られることを保証する。本システムではコミットメントと入力コミットメントの計算に使用する。

### ドメイン分離タグ（Domain Separation Tag）

ハッシュ計算において異なる用途のデータが衝突しないように付与するプレフィックス文字列。本システムでは、コミットメント、入力コミットメント、CT Merkle のリーフ・ノードハッシュにそれぞれ固有のタグを使用する。

### 投票レシート（Vote Receipt）

投票受理時にサーバーが返す応答データ。`voteId`、`commitment`、`bulletinIndex`、`bulletinRootAtCast` を含む。検証では `voteReceipt` として参照される。投票者がローカルに保持する投票時データ（選挙 ID、選択肢、乱数）とは別物であり、zkVM が生成する STARK レシート（Receipt）とも別物。Cast-as-Intended 検証では、投票時データからコミットメントを再計算し、投票レシートのコミットメント値と照合する。

詳細: [コミットメントスキーム](../protocol/commitment.md)、[4 段階検証モデル](../verification/four-stage-model.md#stage-1-cast-as-intended)

---

## STARK 証明

### STARK（Scalable Transparent ARgument of Knowledge）

Trusted setup（信頼されたセットアップ）を必要としない暗号証明方式。ハッシュベースの構成により耐量子計算機性に優位がある。本システムでは RISC Zero zkVM によって投票集計の正当性を証明するために使用する。

### RISC Zero zkVM

RISC-V アーキテクチャ上で通常の Rust コードを実行し、その実行が正しく行われたことの STARK 証明を生成するゼロ知識仮想マシン。ゲストプログラムとホストプログラムから構成される。

### レシート（Receipt）

zkVM が生成する暗号証明オブジェクト。内部に Seal（STARK 証明本体）とジャーナル（公開出力）を含む。`Receipt::verify(image_id)` によって、特定のゲストプログラムが正しく実行されたことを第三者が検証できる。

### ジャーナル（Journal）

zkVM ゲストプログラムの公開出力。現行契約は `methodVersion=12` で、検証済み集計結果、`missingSlots` / `invalidPresentedSlots` / `excludedSlots`、`inputCommitment`、`includedBitmapRoot`、`seenBitmapRoot` などを含む。レシートに暗号学的に束縛されており、改ざんできない。

### Image ID

コンパイル済みのゲストプログラムバイナリを一意に識別するハッシュ値。レシート検証時に期待される Image ID と照合することで、意図したゲストプログラムによって生成された証明であることを確認する。プローバーイメージの更新時に同期して更新が必要。

詳細: [Image ID](../zkvm/image-id.md)

### ゲストプログラム（Guest Program）

zkVM 内部で実行される Rust プログラム。投票データの検証と集計を行い、結果をジャーナルとして出力する。ゲストの実行内容は STARK 証明によって保証される。

### ホストプログラム（Host Program）

zkVM の外部で動作し、ゲストプログラムの実行と証明生成を制御する Rust プログラム。入力データの読み込み、zkVM の起動、レシートとジャーナルの出力を担う。

### 検証サービス（Verifier Service）

Rust で実装された独立した STARK レシート検証プログラム。`Receipt::verify(expected_image_id)` を実行し、レシートの暗号学的正当性を確認する。結果は `verification.json` として保存される。

詳細: [検証サービス](../zkvm/verifier-service.md)

### フェイクレシート（Fake Receipt）

`RISC0_DEV_MODE=1` で生成される暗号学的保証のないレシート。開発効率のためのモックであり、検証サービスは `InnerReceipt::Fake` を自動検出して `dev_mode` ステータスを返す。本番環境では使用してはならない。

### ジャーナル契約（Journal Contract）

`methodVersion` で識別されるジャーナル出力構造の仕様。ゲストプログラムが出力するフィールドの集合と意味を定義する。現行契約は `methodVersion=12`（v1.2）。ゲストプログラムの変更は新しい Image ID の生成を伴い、検証時には期待 Image ID との一致が確認される。

### レシートラッパー JSON

ホストバイナリが出力する `{ "receipt": ..., "image_id": "0x..." }` 形式のラッパー JSON。STARK レシート本体を `image_id` と一緒に運ぶための受け渡し形式で、検証サービスはこの形式を読み込んで `Receipt::verify(expected_image_id)` を実行する。配布対象アーカイブ内のファイル名は `receipt.json`。本書では「レシート」「STARK レシート」「`receipt.json`」「レシートラッパー JSON」を次のように使い分ける:

| 表記                          | 指すもの                                 |
| ----------------------------- | ---------------------------------------- |
| 投票レシート（`voteReceipt`） | サーバーが投票受理時に返す応答データ     |
| STARK レシート（Receipt）     | zkVM が生成する暗号証明オブジェクト      |
| `receipt.json`                | レシートラッパー JSON のファイル名       |
| レシートラッパー JSON         | `{ receipt, image_id }` 構造のホスト出力 |

詳細: [ホストと証明生成](../zkvm/host-and-proving.md#出力ファイル)

---

## 検証パイプライン

> **「検証」と「監査」の使い分け**
> 本書では、`/verify` 画面と内部パイプラインによる判定を **検証**、第三者が `bundle.zip` をローカルに取得して独立に行う確認作業を **監査** と呼び分ける。`reproducibility/` 章は主に「監査」の文脈で書かれており、`verification/` 章は「検証」の文脈で書かれている。

### E2E 検証可能投票（End-to-End Verifiable Voting）

投票者が自分の投票について「意図通りに投じた」「正しく記録された」「正しく集計された」の 3 段階を独立に検証できる投票方式。システム運営者を信頼せずとも投票の完全性を確認できることが目標。

### Cast-as-Intended（意図通りの投票）

検証の第 1 段階。投票者がローカルに保持する投票時データ（選挙 ID、選択肢、乱数）からコミットメントを再計算し、投票レシート（`voteReceipt`）のコミットメント値と照合することで、投票時に意図した選択が正しくコミットメントに反映されたことを確認する。クライアント側で完結する。

### Recorded-as-Cast（記録通りの保存）

検証の第 2 段階。コミットメントが掲示板に正しく記録されたことを、RFC 6962 の包含証明と整合性証明によって確認する。掲示板が追記専用であること（投票が削除・改変されていないこと）を暗号学的に保証する。

### cast-time 証跡（Cast-Time CT Artifact）

投票受理時に CT ツリーへ書き込んだ時点の証跡。具体的には `voteReceipt`（投票レシート）と `userVote.proof`（包含証明パラメータ: `leafIndex`、`treeSize`、`auditPath`）の 2 つを指す。Recorded-as-Cast の検証では両方が必要。Cast-as-Intended では `voteReceipt` のみを使用する。`/api/verify` は store から再構成できた場合にだけこれらを返し、再構成できない場合は関連チェックを `not_run` として fail-closed に扱う。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-2-recorded-as-cast)

### Counted-as-Recorded（記録通りの集計）

検証の第 3 段階。掲示板に記録された全投票が zkVM の集計に過不足なく含まれたことを確認する。除外されたスロットがないこと（`excludedSlots == 0`）は最重要不変条件。

### STARK 検証（STARK Verification）

検証の第 4 段階。STARK レシートが暗号学的に正当であること、および期待される Image ID で生成されたことを確認する。ジャーナルの内容が正しい実行結果であることの最終的な保証。

### 検証チェック（Verification Check）

検証パイプラインを構成する個別の原子的な検証項目。現行実装では 22 個のチェックがあり、それぞれ一意の ID、所属する検証段階、証拠種別、重要度を持つ。Counted-as-Recorded には `counted_election_manifest_consistent` と `counted_close_statement_consistent` も含まれ、公開監査アーティファクトとの整合も required 条件となっている。

詳細: [チェック一覧](../verification/checks-catalog.md)

### ゲーティングロジック（Gating Logic）

検証チェックの結果を集約し、「Verified」「Verification Failed」「Warning」のいずれを表示するかを決定するロジック。required 扱いのチェックが 1 つでも `failed` なら Verified は表示されず、`not_run` / `pending` / `running` や必須証拠欠落でも Verified にはならない。Stage のステータスも、その Stage で required 扱いになるチェック群全体から導出される。

詳細: [ゲーティングロジック](../verification/gating-logic.md)

### 公開監査アーティファクト

`election-manifest.json`（選挙設定の公開監査用スナップショット）と `close-statement.json`（集計締切時点のログ境界を表す公開監査レコード）の総称。Counted-as-Recorded 段階の必須チェック（`counted_election_manifest_consistent`、`counted_close_statement_consistent`）で整合性が検証される。

詳細: [チェック一覧](../verification/checks-catalog.md)、[バンドル構造](../verification/bundle-structure.md)

### 公開可能アーティファクト

秘密データを含まず、第三者検証や監査に利用できるアーティファクトの機密性区分。ここでの「公開可能」は無認証で取得できることを意味しない。配布や取得は `bundle.zip`、capability 保護 API、短命な presigned URL など、個別のアクセス経路に従う。

詳細: [バンドル構造](../verification/bundle-structure.md#公開許可リスト)

### 配布対象アーカイブ（`bundle.zip`）

公開許可リストに基づいて作成される ZIP アーカイブ。[証明バンドル](#証明バンドルproof-bundle) のうち公開可能アーティファクトだけを束ねた部分集合で、`bundle.zip` というファイル名で配布される。現行構成は `public-input.json`、`election-manifest.json`、`close-statement.json`、`receipt.json`、`journal.json` などを含み、`input.json`、`verification.json`、`included-bitmap.json`、`seen-bitmap.json` は含まれない。

### 無認証公開

セッション ID や capability トークンなしで誰でも取得できる公開状態。本書では「公開可能」や「外部クライアント向け API」と区別して扱う。現行のセッションスコープ API や `bundle.zip` 取得経路の多くは capability 保護されており、無認証公開ではない。

詳細: [バンドル構造](../verification/bundle-structure.md#バンドルのアクセス方法)

### zkGate

STARK 検証の結果に基づいて Counted-as-Recorded チェックの評価を制御するゲート。STARK 未解決（`not_run` / `running`）の間、zkGate 対象チェックは `not_run` または `pending` になる。STARK が `failed` の場合、zkGate 対象チェックも `failed` になり得る。

詳細: [ゲーティングロジック](../verification/gating-logic.md#zkgate-stark-結果に基づく-counted-チェックの制御)

### 証拠種別

検証チェックに使用するデータの出所を示す分類。`local`（投票時に確定したユーザー固有データ）、`public`（掲示板や capability 保護 API から取得する、秘密データを含まない検証用データ）、`zk`（zkVM ジャーナルに含まれるデータ）、`demo`（教育用シミュレーション由来データ）の 4 種別がある。

### 重要度（Criticality）

検証チェックの必須性を示す分類。`required`（失敗・未実行・未解決なら Verified をブロック）と `optional`（補助的で、単独では Verified をブロックしない）の 2 段階。なお `recorded_sth_third_party` のように、設定状況に応じて optional から blocking な required 相当に昇格するチェックもある。

詳細: [ゲーティングロジック](../verification/gating-logic.md)、[チェック一覧](../verification/checks-catalog.md)

---

## 掲示板と透明性

### 掲示板（Public Bulletin Board）

全投票コミットメントを時系列で記録する追記専用のログ。RFC 6962 の Certificate Transparency モデルに基づき、包含証明と整合性証明によって第三者が監査可能な透明性を実現する。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md)

### RFC 6962

Certificate Transparency（証明書の透明性）の標準規格。追記専用の Merkle ツリー、リーフハッシュ（`0x00` プレフィックス）とノードハッシュ（`0x01` プレフィックス）のドメイン分離、包含証明、整合性証明の仕様を定義する。本システムの掲示板は、この規格のハッシュ規則と証明アルゴリズムを参照した CT スタイル実装を採用している。

### STH（Signed Tree Head）

掲示板の特定時点における状態の要約。ログ ID、ツリーサイズ、タイムスタンプ、ルートハッシュを含む。複数の独立したソースからの STH を比較することで、サーバーが異なるクライアントに異なるツリーを提示するスプリットビュー攻撃を検出する。

### スプリットビュー攻撃（Split-View Attack）

掲示板サーバーが異なるクライアントに異なるツリー状態を提示する攻撃。特定の投票者に対してのみ投票を除外したツリーを見せることで、不正を隠蔽しようとする。整合性証明と STH の第三者検証によって検出される。

### ルート履歴（Root History）

掲示板のルートハッシュ、ツリーサイズ、タイムスタンプの時系列記録。投票時のルートが最終ツリーの有効なプレフィックスであることを、整合性証明で検証する際に参照する。

詳細: [CT Merkle ツリー](../protocol/ct-merkle.md#整合性証明consistency-proof)

---

## 改ざんシナリオ

### 改ざんシナリオ（Tamper Scenario）

検証システムが不正をどのように検出するかを教育的に示すシミュレーション。S0（正常）から S5（複合改ざん）まで 6 種類が定義されている。

詳細: [改ざんシナリオ](../tamper/scenarios.md)

### 投票除外（Vote Exclusion）

一部の投票を集計から意図的に除外する攻撃。zkVM ジャーナルの `excludedSlots > 0` として検出される。本システムの最重要不変条件により、投票除外がある場合は「Verified」を表示しない。

### 主張集計改ざん（Claimed-Tally Tampering）

公開表示する集計値（claimed tally）を、zkVM が証明した実際の集計値と異なる値に書き換える攻撃の教育的シミュレーション。zkVM の入力・レシート・ジャーナルは正常なまま、公開表示のみを改ざんする。`counted_tally_consistent` チェックで検出される。

### excludedSlots

zkVM ジャーナルに含まれる、除外されたスロットの総数。0 でなければならない。0 より大きい場合は投票の未提示または未計上が発生しており、いかなる場合も「Verified」を表示してはならない。`excludedSlots` が現行の authoritative な公開除外数であり、`excludedCount` は古い入力を安全側に倒すための互換フィールドとしてだけ扱う。現行レスポンスでは `excludedCount` を新規に返さない。

詳細: [4 段階検証モデル](../verification/four-stage-model.md#stage-3-counted-as-recorded)、[ゲーティングロジック](../verification/gating-logic.md)

---

## インフラストラクチャ

### ECS Fargate

AWS のサーバーレスコンテナ実行環境。本システムでは STARK 証明生成に必要な大量のメモリ（32 GB）と CPU（16 vCPU）を提供するために使用する。アイドル時のコストは 0。

詳細: [非同期プローバー](../aws/async-prover.md)

### Step Functions

AWS のワークフローオーケストレーションサービス。イメージ署名検証 → ECS プローバー実行 → コールバックの一連のフローを管理する。

### 非同期証明モード（Async Proving）

SQS → Step Functions → ECS Fargate の経路で STARK 証明を非同期に生成するモード。集計リクエスト（`POST /api/finalize`）は 202 Accepted を返し、クライアントはステータスポーリングで完了を待つ。

### 同期証明モード（Sync Proving）

ローカルプロセスで zkVM ホストバイナリを直接実行し、STARK 証明を同期的に生成するモード。開発環境で使用される。

### イメージ署名検証（Image Signing）

ECS タスクで使用するプローバーコンテナイメージが、信頼できるビルドパイプラインから生成されたことを検証する仕組み。AWS Signer を使用し、Step Functions のゲートとして機能する。

詳細: [イメージ署名](../aws/image-signing.md)

### 証明バンドル（Proof Bundle）

zkVM の実行結果を検証可能な形で保存・配布するためのアーティファクト群を指す **上位概念**。公開可能アーティファクト（`public-input.json` など）と非公開アーティファクト（`input.json`、`verification.json`、`included-bitmap.json`、`seen-bitmap.json` など）の両方を含む。`public` /「公開可能」は秘密情報を含まず検証に利用可能であるという機密性の分類であり、無認証公開を意味しない。

公開許可リストで取り出した部分集合が [配布対象アーカイブ](#配布対象アーカイブbundlezip) であり、それを ZIP 化したファイル名が `bundle.zip` である。3 者の関係は次のとおり:

```text
証明バンドル ⊃ 配布対象アーカイブ ⊃ bundle.zip（ファイル）
```

「証明バンドル」は文脈上、AWS / S3 上の隣接オブジェクトや非公開アーティファクトも含めて議論したい箇所で使うのが望ましい。単に公開可能な ZIP を指す場合は `bundle.zip` または「配布対象アーカイブ」を使う。

詳細: [バンドル構造](../verification/bundle-structure.md)

### 隣接オブジェクト（Sibling Object）

S3 上で `bundle.zip` と同じ prefix（`sessions/{sessionId}/{executionId}/`）に配置される非 bundle ファイル。`included-bitmap.json`、`seen-bitmap.json`、`verification.json` など。`bundle.zip` には含まれないが、コールバック復元や検証レポート配信で利用される。

詳細: [バンドル構造](../verification/bundle-structure.md#バンドルディレクトリ構造)

---

## セッションと API

### セッション（Session）

一連の投票フロー（セッション作成 → 投票 → 集計 → 検証）を管理する単位。一意の `sessionId`（UUID v4）で識別される。投票・集計中は 30 分、検証中は 24 時間の有効期限を持つ。

### 選挙（Election）

投票の論理的な単位。一意の `electionId`（UUID v4）で識別され、コミットメントのドメイン分離に使用される。選挙設定ハッシュ（`electionConfigHash`）が期待投票数などの設定を束縛する。

### 集計確定（Finalization）

全投票の収集後に zkVM 入力を構築し、STARK 証明を生成するプロセス。同期モード（ローカル実行）と非同期モード（ECS Fargate）の 2 つの実行パスがある。

### X-Session-ID

多くの API リクエストで付与される HTTP ヘッダー。セッションスコーピングに使用され、異なるセッション間のデータアクセスを防止する。`POST /api/session` は新規セッション作成のため不要。

### X-Session-Capability

`POST /api/session` のレスポンスで返る署名付きセッショントークンを運ぶ HTTP ヘッダー。このヘッダーが運ぶ値を capability トークンと呼ぶ。`/api/vote`、`/api/progress`、`/api/finalize`、`/api/verify`、`/api/verification/run`、`/api/bulletin/*`、`/api/botdata/:id`、`/api/bitmap-proof`、`/api/sth`、`/api/sessions/:sessionId/status`、`/api/verification/bundles/...`、`/api/zkvm-input-hash` など session-scoped / capability 保護 API で必須。

### capability 保護 API

セッション capability の提示を要求する API。多くの場合は `X-Session-Capability` を使い、ヘッダースコープの API では `X-Session-ID` も併用する。capability 保護 API は外部クライアント向けに文書化されていても、無認証公開 API ではない。

### Turnstile

Cloudflare が提供する CAPTCHA サービス。`/api/vote` と `/api/finalize` で Bot による不正アクセスを防止するために使用する。`TURNSTILE_BYPASS=1` は fail-closed で、`AWS_BRANCH` などのランタイムマーカーが明示的に非本番（`develop`/`dev`）と判定できる場合のみ有効。

---

## 定数

| 定数名               | 値                          | 説明                                         |
| -------------------- | --------------------------- | -------------------------------------------- |
| `BOT_COUNT`          | 63                          | サーバーが自動生成するボット投票数           |
| `MERKLE_TREE_DEPTH`  | 6                           | Merkle ツリーの深度（2^6 = 64 リーフに対応） |
| `VOTE_CHOICES`       | A, B, C, D, E               | 投票で選択可能な選択肢                       |
| コミットドメインタグ | `stark-ballot:commit\|v1.0` | コミットメントハッシュのドメイン分離タグ     |
| 入力ドメインタグ     | `stark-ballot:input\|v1.0`  | 入力コミットメントのドメイン分離タグ         |
| リーフドメインタグ   | `stark-ballot:leaf\|v1`     | CT Merkle リーフハッシュのドメイン分離タグ   |

<!-- source: src/lib/zkvm/types.ts, src/lib/merkle/rfc6962-merkle-tree.ts, src/lib/verification/verification-checks.ts, src/lib/verification/verification-summary.ts, src/lib/verification/consistency-verifier.ts, src/lib/verification/sth-verifier.ts, src/lib/verification/verification-bundle.ts, src/server/api/handlers/bitmapProof.ts, src/lib/zkvm/bitmap.ts, src/shared/constants.ts, src/types/server.ts, src/types/voteStore.ts, zkvm/methods/guest/src/main.rs -->
