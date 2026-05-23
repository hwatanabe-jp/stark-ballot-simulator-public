# イメージ署名

AWS Signer でプローバーイメージを署名し、ECS 実行前にゲートとして検証する仕組みを扱う章です。

STARK 証明は「特定のゲストプログラムが正しく実行された」ことを保証しますが、そもそもそのゲストプログラムを含むコンテナイメージ自体が改ざんされていないことも保証する必要があります。イメージ署名は、信頼されたビルドパイプラインが生成したイメージのみが証明生成に使用されることを担保するセキュリティゲートです。

## 脅威モデル

署名なしの場合、未承認イメージへの差し替えは検証段階の Image ID 照合や STARK レシート検証で拒否され得るものの、証明生成インフラ上で未承認イメージが実行されること自体は起動前に止められません。署名ありの場合は、Step Functions が起動前に署名ステータスを確認し、署名なし/未完了であればタスク起動を拒否します。

STARK 証明は Image ID（ゲストバイナリの暗号的識別子）に紐づきますが、イメージ署名はそれとは別レイヤで「未承認コンテナイメージの実行」を起動前に抑止します。両者は相補的な防御です。

| 保証の種類               | メカニズム            | 検出対象                                 |
| ------------------------ | --------------------- | ---------------------------------------- |
| ゲストプログラムの同一性 | Image ID（RISC Zero） | ゲストバイナリの改変                     |
| イメージ実行許可         | AWS Signer            | 未承認または署名未完了のコンテナイメージ |

## 署名フロー

### ビルドと署名

CodeBuild がプローバーコンテナイメージをビルドし、ビルド済み ARM64 コンテナから `host --print-image-id --json` を実行して guest ImageID と `methodVersion` を抽出します。その後 ECR に push し、ECR 上で解決されたイメージ digest、digest 固定 URI、ImageID、`methodVersion`、Git SHA、RISC Zero toolchain image を `image-metadata.json` として出力します。その digest を運用手順で Terraform の `ecs_image_uri` に反映し、Step Functions は digest 固定のイメージ参照に対して署名ステータスを確認します。
ECR マネージド署名が有効な環境では、push 後に AWS Signer プロファイルに基づく署名ステータスが対象 digest に付与されます。

```mermaid
sequenceDiagram
  participant GH as GitHub
  participant CB as CodeBuild
  participant ECR as ECR
  participant SGN as AWS Signer

  GH->>CB: ソースコード取得
  CB->>CB: Docker イメージビルド<br/>(ARM64)
  CB->>CB: ImageID / methodVersion 抽出
  CB->>ECR: イメージをプッシュ<br/>(タグ付き)
  ECR-->>CB: digest を解決<br/>metadata 出力
  CB->>CB: image-metadata.json 生成
  ECR->>SGN: （ECR managed signing 有効時）署名処理
  SGN->>ECR: 署名ステータス更新
  Note over ECR: deploy/runtime では<br/>Terraform に反映した digest 固定で参照
```

> 注: このリポジトリでコード化されているのは署名ステータス確認（`DescribeImageSigningStatus`）です。  
> 署名付与そのもの（ECR managed signing の有効化）は、ECR 側の設定・運用が前提です。

CodeBuild の build/push では運用上のタグを使用できますが、Terraform に渡す `ecs_image_uri` と Step Functions が署名確認する対象は常にダイジェスト固定（`@sha256:<64-hex>`）です。これにより、タグの上書きによるイメージのすり替えを防止します。ベースとなる RISC Zero ツールチェーンイメージも同様に、ECR 上のタグから digest を解決した `RISC0_TOOLCHAIN_IMAGE` として Docker build に渡され、非 digest 形式は buildspec 側で拒否されます。

生成された `image-metadata.json` は、S3 metadata bucket の `prover-images/<env>/latest.json`、`prover-images/<env>/by-digest/sha256-<digest>.json`、`prover-images/<env>/by-git-sha/<sha>.json` に保存されます。さらに SSM Parameter Store の current pointer に同じ候補 metadata JSON を書き込み、ImageID と digest 固定 URI が別々にずれないようにします。これらは昇格前の候補であり、運用では ECR 署名ステータスと必要な proof smoke を確認してから `imageId-mapping.json` と Terraform の `ecs_image_uri` に反映します。

### 実行前確認

Step Functions ステートマシンの最初のステートで、`check-image-signature` Lambda がイメージの署名ステータスを確認します。

```mermaid
stateDiagram-v2
  [*] --> VerifyImageSignature: Step Functions 開始
  VerifyImageSignature --> CheckImageSignature

  state CheckImageSignature <<choice>>
  CheckImageSignature --> RunProver: status = COMPLETE
  CheckImageSignature --> FinalizeSignatureFailed: status ≠ COMPLETE

  state FinalizeSignatureFailed {
    [*] --> CallbackFailed: エラー情報を通知
  }

  state RunProver {
    [*] --> ECSTask: 署名ステータス確認済みイメージで実行
  }
```

`check-image-signature` Lambda は以下の処理を行います。

1. ECR の `DescribeImageSigningStatus` API を呼び出す
2. 指定されたリポジトリ名とイメージダイジェストに対する署名ステータスを取得
3. 取得した `status`（`COMPLETE` / それ以外）を Step Functions に返す

署名ステータスが `COMPLETE` でない場合、Step Functions の Choice ステートが `FinalizeSignatureFailed` に遷移し、コールバック Lambda に `ImageSignatureVerificationFailed` エラーを通知します。ECS タスクは一切起動されません。

> **ステータス確認と暗号学的検証の違い**
> 本システムの実行前チェックは ECR の `DescribeImageSigningStatus` が返すステータス参照であり、署名値そのものの暗号学的検証（証明書チェーン検証など）は行いません。独立検証が必要な場合は [Notation](https://notaryproject.dev/) などの外部ツールを併用してください。

## ECR リポジトリとイメージ管理

### リポジトリ構成

| リポジトリ                                 | 用途                                   | ライフサイクル         |
| ------------------------------------------ | -------------------------------------- | ---------------------- |
| `stark-ballot-simulator/zkvm-prover-{env}` | プローバーコンテナイメージ             | 最新 10 イメージを保持 |
| `stark-ballot-simulator/risc0-toolchain`   | RISC Zero ツールチェーンベースイメージ | 最新 5 イメージを保持  |

両リポジトリとも、プッシュ時の脆弱性スキャン（Scan on Push）が有効です。

### ダイジェスト固定

Terraform の `ecs_image_uri` 変数には、ダイジェスト固定の URI のみが許可されます。バリデーションルールにより `@sha256:<64-hex>` 形式が強制されます。

Step Functions の定義に含まれるイメージダイジェストは、Terraform の変数から以下のように抽出されます。

- **リポジトリ名**: URI の `@` より前の部分からレジストリホストを除去
- **ダイジェスト**: URI の `@` より後の部分（`sha256:...`）

この分解により、`check-image-signature` Lambda は正確なリポジトリとダイジェストの組み合わせで署名ステータスを確認できます。

## ビルドパイプライン

### CodeBuild プロジェクト

2 つの CodeBuild プロジェクトがイメージのビルドを担当します。

| プロジェクト                                     | ビルド対象         | タイムアウト | インスタンス |
| ------------------------------------------------ | ------------------ | ------------ | ------------ |
| `stark-ballot-simulator-fargate-prover-{env}`    | プローバーイメージ | 30 分        | ARM64 Small  |
| `stark-ballot-simulator-risc0-toolchain-builder` | ベースイメージ     | 120 分       | ARM64 Large  |

RISC Zero ツールチェーンのビルドは低頻度（ツールチェーンバージョン更新時のみ）ですが、ビルドに時間を要するため Large インスタンスと長いタイムアウトが設定されています。

### CodeBuild の IAM 権限

CodeBuild ロールには以下の権限が付与されています。

| 権限カテゴリ         | 対象 API                                                   | 目的                                                                                    |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ECR                  | `GetAuthorizationToken`, `PutImage` 等                     | イメージのプッシュ                                                                      |
| AWS Signer           | `SignPayload`, `GetSigningProfile`                         | 署名連携用の権限（運用/拡張時）                                                         |
| CloudWatch Logs      | `CreateLogGroup`, `PutLogEvents` 等                        | ビルドログの出力                                                                        |
| S3                   | `GetObject`, `PutObject`                                   | CodePipeline 連携時のアーティファクト入出力、metadata bucket への候補 metadata 書き込み |
| SSM Parameter Store  | `PutParameter`                                             | current prover image metadata pointer の更新                                            |
| CodeStar Connections | `codestar-connections:UseConnection`, `GetConnectionToken` | 接続方式切り替えに備えた権限（現行 CodeBuild source は `GITHUB`）                       |

## Image ID との関係

イメージ署名と [Image ID](../zkvm/image-id.md) は異なるレイヤのセキュリティメカニズムですが、共に「正しいプログラムが実行されたこと」の信頼チェーンを構成します。

```mermaid
flowchart TD
  subgraph "ビルド時"
    BUILD["コンテナイメージ<br/>ビルド"] --> SIGN["ECR managed signing<br/>(運用設定)"]
    BUILD --> IMGID["ARM64 ImageID / methodVersion 抽出"]
    IMGID --> META["candidate metadata<br/>(S3 + SSM current)"]
    META --> PROMOTE["mapping / Terraform 値へ昇格"]
    PROMOTE --> MAP["imageId-mapping.json<br/>と ecs_image_uri に反映"]
  end

  subgraph "実行時"
    VERIFY_SIG["イメージ署名ステータス確認<br/>(Step Functions)"] --> RUN["プローバー実行"]
    RUN --> RECEIPT["レシート生成<br/>(Image ID を含む)"]
  end

  subgraph "検証時"
    RECEIPT --> VERIFY_RECEIPT["レシート検証<br/>(verifier-service)"]
    MAP --> VERIFY_RECEIPT
    VERIFY_RECEIPT --> MATCH{"Image ID<br/>一致?"}
  end

  SIGN --> VERIFY_SIG
```

候補 metadata から `imageId-mapping.json` / `ecs_image_uri` への昇格手順は[ビルドと署名](#ビルドと署名)に記載しています。

| 検証ポイント  | タイミング | 検証主体                | 失敗時の動作         |
| ------------- | ---------- | ----------------------- | -------------------- |
| イメージ署名  | 証明生成前 | Step Functions + Lambda | ECS タスクの起動拒否 |
| Image ID 照合 | 検証時     | verifier-service        | 検証失敗の報告       |

<!-- source: terraform/lambda_check_image_signature.tf, terraform/lambda/check-image-signature/index.mjs, terraform/codebuild.tf, terraform/ecr.tf, terraform/step_functions.tf -->
