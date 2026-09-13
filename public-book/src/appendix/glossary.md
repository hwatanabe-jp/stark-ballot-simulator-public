# 用語集

本文で使う言葉を、証拠や処理との関係から引けるようにまとめています。

## 暗号プリミティブ

### コミットメント（総称）

内容を決めた後で取り替えていないかを確かめるための値です。本書では、一票の選択肢と乱数に結び付く「投票コミットメント」と、集計へ渡す公開入力の一部に結び付く「入力コミットメント」を区別します。

### 投票コミットメント（Vote Commitment）

選挙 ID、選択肢、乱数を定めた形式で SHA-256 に入力して得る値です。公開された値から投票先を推測しにくくし、後から別の選択肢へ開き直すことを困難にします。このデモのサーバーは投票先と乱数を受け取ります。[符号化と性質](../protocol/commitment.md)。

### Merkle ルート（Bulletin Root）

掲示板上のコミットメントを Merkle ツリーにまとめた、頂点のハッシュです。票の内容や順序を変えると通常は値が変わるため、保持したルートとの比較で変更を検出できます。

### Merkle パス（Audit Path）

葉からルートを計算し直すために必要な、兄弟ノードのハッシュ列です。全票を受け取らずに自票の包含を確かめるために使います。

### 包含証明（Inclusion Proof）

ある位置の票が、指定したルートとツリーサイズの掲示板に含まれることを確かめる証拠です。位置と Merkle パスからルートを再計算します。[掲示板の証明](../protocol/ct-merkle.md)。

### 整合性証明（Consistency Proof）

古いツリーが新しいツリーの先頭部分として残っていることを確かめる証拠です。比較する二つのルートとサイズを基準に、追記以外の変更がないかを検査します。[RFC 6962 の整合性証明](../protocol/ct-merkle.md#整合性証明consistency-proof)。

### 入力コミットメント（Input Commitment）

ゲストへ渡した公開入力のうち、選挙 ID、掲示板のルートとサイズ、期待数、票数、各票の位置・コミットメント・Merkle パスをハッシュした値です。`public-input.json` 全体のハッシュではありません。[正確な対象フィールド](../protocol/input-commitment.md)。

### STH ダイジェスト（Signed Tree Head Digest）

ログ ID、ツリーサイズ、時刻、ルートをハッシュした値です。比較対象が同じ掲示板の状態を指しているかを調べます。このデモのダイジェスト照合は STH の署名検証ではありません。[照合方法](../protocol/sth-digest.md)。

### 包含ビットマップルート（Included Bitmap Root）

各位置が集計に採用されたかを表すビットマップの Merkle ルートです。位置に対応するビットが 1 かを、区画と Merkle 証明で確かめます。[ビットマップ](../protocol/bitmap-merkle.md)。

### 提示ビットマップルート（Seen Bitmap Root）

ゲストに提示された範囲内の位置を表すビットマップの Merkle ルートです。採用済みビットマップと比べて、未提示と提示後の不採用を区別します。[ビットマップ](../protocol/bitmap-merkle.md)。

### 正準エンコーディング（Canonical Encoding）

フィールドの順序、整数の幅、バイト順、並べ替え規則などを固定したバイト列表現です。同じ意味の入力から同じハッシュを計算するために使います。

### ドメイン分離タグ（Domain Separation Tag）

ハッシュするデータの用途を区別する先頭の値です。投票コミットメントと入力コミットメント、Merkle ツリーの葉と内部ノードなどが、同じバイト列の意味を取り違えないようにします。

### 投票レシート（Vote Receipt）

投票を受理したサーバーが返す記録です。`voteId`、`commitment`、`bulletinIndex`、`bulletinRootAtCast`、`castAtMs` を含みます。投票時の選択肢と乱数から再計算した値を、このコミットメントと照合します。計算の証明を含む STARK レシートとは別です。

## STARK 証明

### STARK（Scalable Transparent ARgument of Knowledge）

計算が定めた規則に従ったことを検証する暗号証明の方式です。このデモでは RISC Zero の STARK 証明を使い、秘密の初期設定値を必要とする trusted setup は行いません。[zkVM の基礎](../zkvm/foundations.md)。

### RISC Zero zkVM

RISC-V のプログラムを実行し、その実行に対する証明を作る仮想マシンです。このデモのゲストは Rust で投票の検査・集計を実装しています。[構成](../zkvm/foundations.md)。

### レシート（Receipt）

zkVM の計算の証明と公開出力を運ぶオブジェクトです。別途選んだ期待 Image ID を `Receipt::verify` に渡して検証します。

### ジャーナル（Journal）

ゲストが公開する出力です。得票数、位置の欠落・不採用数、入力コミットメント、ビットマップルートなどを含み、レシートの証明に結び付きます。別ファイルの `journal.json` は、検証済みレシートから取り出した値と照合して使います。[フィールドの定義](../zkvm/guest-program.md)。

### Image ID

実行するゲストのメモリーイメージを識別する 256 ビットの値です。検証者が期待値を指定し、別のプログラムの証明を受け入れないようにします。コンテナイメージのダイジェストとは別です。[選択方法](../zkvm/image-id.md)。

### ゲストプログラム（Guest Program）

zkVM 内で投票を検査・集計し、ジャーナルを出力するプログラムです。証明は、この指定プログラムの実行と出力を結び付けます。[処理順序](../zkvm/guest-program.md)。

### ホストプログラム（Host Program）

zkVM の外で入力を読み、ゲスト実行と証明生成を進め、レシートなどのファイルを書き出すプログラムです。[証明生成](../zkvm/host-and-proving.md)。

### 検証サービス（Verifier Service）

STARK レシートを検証する Rust バイナリ `verifier-service` です。期待 Image ID とレシートから結果を計算し、レポートを出力します。[終了コードとレポート](../zkvm/verifier-service.md)。

### フェイクレシート（Fake Receipt）

RISC Zero の開発モードで作る、production STARK の暗号学的保証を持たないレシートです。開発モードを扱える検証ビルドは `dev_mode` として区別し、production feature のビルドは開発モードを無効にします。[検証サービス](../zkvm/verifier-service.md)。

### ジャーナル契約（Journal Contract）

ゲストが出すフィールドと意味を定める仕様です。現行は `methodVersion=14`。バージョンだけでプログラムを信用せず、レシート検証では期待 Image ID も指定します。

### レシートラッパー JSON

ホストが出力する `{ "receipt": ..., "image_id": "0x..." }` という形式です。ファイル名は `receipt.json`。添えられた `image_id` は、検証者が別途選ぶ期待 Image ID の代わりにはなりません。

## 検証パイプライン

### fail-closed

証拠の不足やデータの不整合を、推測で成功として扱わない方針です。状況に応じて待機、証拠不足、失敗を表示し、必要な条件が満たされるまで Verified にしません。[表示条件](../verification/gating-logic.md)。

### E2E 検証可能投票（End-to-End Verifiable Voting）

意図した票が記録され、その記録が集計されたことを確かめられる投票の考え方です。このデモの画面は Cast をブラウザで確認し、その他のチェックはサーバーの報告を使います。[実行場所と信頼関係](../verification/design-and-flow.md)。

### Cast-as-Intended（意図通りの投票）

手元の選択肢と乱数から投票コミットメントを作り直し、投票レシートと一致するかをブラウザで確かめる段階です。[第1段階](../verification/four-stage-model.md#stage-1-cast-as-intended)。

### Recorded-as-Cast（記録通りの保存）

投票時の包含証明と、その後の整合性証明を使い、送った票が掲示板に残っているかを確かめる段階です。[第2段階](../verification/four-stage-model.md#stage-2-recorded-as-cast)。

### cast-time 証跡（Cast-Time CT Artifact）

投票受理時のレシートと、その時点の掲示板ルートに対する包含証明です。最終掲示板への包含とは確認する時点が違います。[証拠の取得](../verification/design-and-flow.md)。

### Counted-as-Recorded（記録通りの集計）

全位置の採用、自票の採用、公開入力と証明の一致、表示集計と証明の出力の一致などを確かめる段階です。[第3段階](../verification/four-stage-model.md#stage-3-counted-as-recorded)。

### STARK 検証（STARK Verification）

期待するゲストの実行に、レシート内の公開出力が結び付くことを暗号学的に確かめる段階です。この成功だけで四段階全体の成功にはなりません。[第4段階](../verification/four-stage-model.md#stage-4-stark-verification)。

### 検証チェック（Verification Check）

検証の中で個別に結果を持つ項目です。ID、段階、証拠種別、必須・補助の区分を定義します。[全22チェック](../verification/checks-catalog.md)。

### ゲーティングロジック（Gating Logic）

チェック結果、証拠、実行状態を合わせて最終表示を決める規則です。必須成功に加えて、全体の整合条件と補助チェックの状態も評価します。[判定の優先順位](../verification/gating-logic.md)。

### 公開監査アーティファクト

選挙設定の `election-manifest.json` と、締切時点の掲示板を示す `close-statement.json` です。公開入力・ジャーナルと照合します。[バンドル構造](../verification/bundle-structure.md)。

### 締切ステートメント（`close-statement.json`）

集計締切時点のログ ID、ツリーサイズ、ルート、時刻、STH ダイジェストをまとめたファイルです。本文では「締切宣言」とも呼びます。[照合条件](../verification/checks-catalog.md#counted_close_statement_consistent)。

### 公開可能アーティファクト

投票の秘密を含めず、第三者へ渡せるようにした証拠ファイルです。「公開可能」は内容の分類であり、ダウンロード時にはセッション認証が必要です。[公開境界](../verification/public-boundary.md)。

### 配布対象アーカイブ（`bundle.zip`）

公開を許可した証拠だけをまとめた ZIP です。秘密入力、検証レポート、完全なビットマップは同梱しません。[同期・非同期の構成](../verification/bundle-structure.md)。

### 保護された検証レポート（`verification.json`）

検証サービスの結果を記録したファイルです。ZIP とは別に、セッション認証が必要な report API から取得します。[取得 API](../api/endpoints.md#get-apisessionssessionidfinalizationsfinalizationidartifactsreport)。

### 無認証公開

セッションの鍵などを提示せず取得できる状態です。公開可能な `bundle.zip` も、通常の取得 API は認証を要求します。

### zkGate

STARK の検証状態に応じて、一部の Counted チェックを待機・失敗・デモ用評価へ切り替える処理です。[対象と優先順位](../verification/checks-catalog.md#stark-結果への依存)。

### 証拠種別

チェックの入力元の分類です。`local` は投票者の手元の情報、`public` は公開可能な検証データ、`zk` はゲストの公開出力、`demo` は開発用レシートを許した際のデモ用評価を示します。[チェック一覧](../verification/checks-catalog.md#証拠種別)。

### 重要度（Criticality）

チェックを `required`（必須）と `optional`（補助）に分ける属性です。補助でも失敗や未実行があれば完全成功ではなく制限付きになり、実行中なら待機します。第三者 STH のチェックは、照合先の設定によって必須になります。[表示条件](../verification/gating-logic.md)。

## 掲示板と透明性

### 掲示板（Public Bulletin Board）

投票コミットメントを順に追記するログです。Merkle ルートと証明を使って、特定の記録の包含や追記前後の関係を検査できます。[掲示板](../protocol/ct-merkle.md)。

### RFC 6962

Certificate Transparency の仕様です。このデモは、その Merkle ツリーのハッシュ規則と包含・整合性証明を利用します。CT の署名や監視の仕組み全体を実装したという意味ではありません。[利用している規則](../protocol/ct-merkle.md)。

### STH（Signed Tree Head）

ログ ID、ツリーサイズ、時刻、ルートで表す掲示板の状態です。名前は CT に由来しますが、このデモはそれらのダイジェストを比較し、STH 署名そのものは検証しません。[STH ダイジェスト](../protocol/sth-digest.md)。

### スプリットビュー攻撃（Split-View Attack）

相手によって異なる掲示板を見せる攻撃です。それぞれの掲示板の中だけで包含・整合性を調べても見逃し得るため、独立した観測先と状態を照合します。[照合の条件](../protocol/sth-digest.md)。

### ルート履歴（Root History）

追記に伴う掲示板のルート、サイズ、時刻の記録です。投票時から最終時点までの追記関係を検証するために使います。

## 改ざんシナリオ

### 改ざんシナリオ（Tamper Scenario）

検出の仕組みを観察するための操作です。S0 は正常、S1・S3・S5 は一票の入力除外、S2・S4 は表示集計の変更を行います。[シナリオ一覧](../tamper/scenarios.md)。

### 投票除外（Vote Exclusion）

掲示板上の票を集計入力へ渡さないなど、集計に採用しないことです。未提示や不採用の位置は `excludedSlots` に残ります。

### 主張集計改ざん（Claimed-Tally Tampering）

表示用の得票数だけを、証明内の集計と違う値に変える操作です。入力と証明が正常でも、`counted_tally_consistent` で不一致を検出します。

### excludedSlots

集計に採用されなかった掲示板上の位置数です。`missingSlots + invalidPresentedSlots` に等しく、ゼロでなければ Verified にはできません。拒否レコード数 `rejectedRecords` とは異なります。[位置とレコード](../zkvm/guest-program.md)。

## インフラストラクチャ

### ECS Fargate

サーバーを直接管理せずコンテナを実行する AWS のサービスです。このデモの重い証明生成を担当します。[実行資源](../aws/design-and-services.md)。

### Step Functions

処理の順序、待機、失敗時の分岐を管理する AWS のサービスです。署名検証、プローバー起動、結果の通知などをつなぎます。[非同期処理](../aws/async-prover.md)。

### 非同期証明モード（Async Proving）

集計要求に受付結果を返した後、別のジョブで証明を生成する方式です。ブラウザは進捗を問い合わせて完了を待ちます。[非同期プローバー](../aws/async-prover.md)。

### 同期証明モード（Sync Proving）

要求を処理するローカルプロセスからホストを起動し、結果を待つ方式です。使うレシートの種類は実行プロファイルによって異なります。

### Prover semaphore

同時に証明を生成するジョブ数を制限する仕組みです。DynamoDB に利用中の枠を記録し、通常は Step Functions が解放します。残った枠は専用の清掃処理が終了確認後に回収します。[非同期プローバー](../aws/async-prover.md)。

### Quiesced phase

DynamoDB の復旧・切替の途中で、新規セッションと非同期キューの処理を停止する状態です。[復旧時の段階](../aws/terraform.md#dynamodb-recovery-selection)。

### Develop operator gate

開発環境のページと API への入口を制限する CloudFront の署名付き Cookie です。環境へのアクセスと、個々のセッションへの capability 認証を別々に確認します。[入口の認証](../aws/runtime-boundary.md)。

### Saved-plan lane

Terraform が作成して保存した計画を承認し、その同じ計画を適用する変更経路です。通常変更とロールバックで承認条件を定めます。[計画と承認](../aws/terraform.md)。

### Release authority

どのビルド済みイメージやアプリ成果物を採用できるかを決める、検査済みの記録と、それを選ぶポインターです。[イメージの選択](../aws/image-signing.md)と[受入記録](../aws/terraform.md)を参照できます。

### イメージ署名検証（Image Signing）

起動するコンテナのダイジェストに対し、許可した署名元の署名が有効かを確認する処理です。ゲストの Image ID とレシートの検証とは別に行います。[イメージ署名](../aws/image-signing.md)。

### 証明バンドル（Proof Bundle）

証明生成・検証に関わるファイル群を指す語です。秘密入力や保護対象のファイルも含めて述べるときに使います。配布する ZIP を指す場合は `bundle.zip` と明記します。[ファイルの配置](../verification/bundle-structure.md)。

### 隣接オブジェクト（Sibling Object）

S3 で ZIP と同じ集計用の接頭辞の下に保存する、ZIP 外のファイルです。完全なビットマップや検証レポートなどを保存します。[保存構造](../verification/bundle-structure.md#バンドルディレクトリ構造)。

## セッションと API

### セッション（Session）

作成から投票、集計、検証までの一連の操作を管理する単位です。`sessionId` で識別し、capability token でアクセスを保護します。[保存と継続](../api/session-lifecycle.md)。

### 選挙（Election）

候補や期待票数などの設定に結び付く投票の単位です。`electionId` を投票コミットメントにも含め、別の選挙の票と取り違えないようにします。

### 集計確定（Finalization）

票を集めた後、集計入力を作り、ゲストを実行して証拠を生成し、結果を保存する作業です。STARK レシートを検証する作業とは別の状態を持ちます。

### X-Session-Capability

セッションへのアクセス権を示す署名付きトークンを送る HTTP ヘッダーです。トークンは `POST /api/sessions` の成功応答で受け取ります。[API の共通仕様](../api/endpoints.md#共通仕様)。

### capability 保護 API

セッションの鍵を `X-Session-Capability` で提示して呼び出す API です。URL のセッション ID だけでは取得できません。[API の共通仕様](../api/endpoints.md#共通仕様)。

### Turnstile

自動化された不正アクセスを抑えるための Cloudflare の仕組みです。セッション作成、投票、集計要求でトークンを使い、必須条件は実行環境の設定に従います。[要求の条件](../api/endpoints.md#ボディサイズturnstileレート制限)。

## 定数

| 名前                | 値            | 用途                       |
| ------------------- | ------------- | -------------------------- |
| `BOT_COUNT`         | 63            | 自分の一票に加えるボット票 |
| `MERKLE_TREE_DEPTH` | 6             | 64 葉に対応する深さ        |
| `VOTE_CHOICES`      | A、B、C、D、E | 候補                       |

ハッシュに使うタグとバイト列は、[投票コミットメント](../protocol/commitment.md)、[入力コミットメント](../protocol/input-commitment.md)、[掲示板](../protocol/ct-merkle.md)で定義します。

<!-- source: packages/zkvm-contract/src/zkvm/types.ts, packages/merkle/src/rfc6962-merkle-tree.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/verification-summary.ts, packages/verification/src/verification/consistency-verifier.ts, packages/verification/src/verification/sth-verifier.ts, packages/verification/src/verification/verification-bundle.ts, apps/api/src/server/api/handlers/bitmapProof.ts, packages/zkvm-contract/src/zkvm/bitmap.ts, packages/domain/src/shared/constants.ts, packages/domain/src/types/server.ts, packages/domain/src/types/voteStore.ts, zkvm/methods/guest/src/main.rs -->
