# Terraform State 管理設定
#
# 現在は S3 backend を使用
# ロックは S3 lockfile を使用
#
# 実運用の bucket 名は tracked ファイルに置かず、以下で生成した git-ignored
# backend config を terraform init に渡します。
#
#   pnpm terraform:backend
#   terraform -chdir=terraform init -backend-config=backend.local.hcl
#
# backend 設定を変更した後は terraform init -reconfigure を実行

terraform {
  backend "s3" {}
}
