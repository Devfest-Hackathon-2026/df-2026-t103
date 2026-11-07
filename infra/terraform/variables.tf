variable "project_id" {
  type        = string
  description = "デプロイ対象の GCP プロジェクトID（例: project-7efcc4c4-6c86-490c-ba5）。.firebaserc の moshimoshimonshin とは別IDのため確定要。"
}

variable "region" {
  type        = string
  description = "リージョン（東京）。"
  default     = "asia-northeast1"
}

variable "api_image" {
  type        = string
  description = "API/Worker の初期コンテナイメージ。実運用では CD（#38）が SHA 付きイメージへ差し替える（image は ignore_changes 対象）。"
  default     = "asia-northeast1-docker.pkg.dev/PROJECT_ID/api/api:latest"
}

variable "storage_bucket" {
  type        = string
  description = "アプリ用 Storage バケット名。空ならTerraform管理の画像専用bucketを新規作成する。"
  default     = ""
}

variable "cors_origins" {
  type        = string
  description = "API_CORS_ORIGINS（カンマ区切りの許可 origin）。"
  default     = "https://hospital.moshimoshimonshin.com"
}
