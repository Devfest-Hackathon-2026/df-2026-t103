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
  description = "API_CORS_ORIGINS（カンマ区切り）。未指定なら対象projectの患者Hosting originのみ。追加originは実在確認後に指定する。"
  default     = null
}

variable "synthetic_self_service_enabled" {
  type        = bool
  description = "本人の明示opt-inによる送信保存のみの合成デモ。環境ごとに別途承認した場合だけ有効化する。"
  default     = false
  nullable    = false
}

variable "synthetic_self_service_max_facilities" {
  type        = number
  description = "自己専用合成デモ施設の累積作成上限（整数1〜10000）。削除で補充しない。"
  default     = 1000
  nullable    = false

  validation {
    condition = (
      var.synthetic_self_service_max_facilities >= 1 &&
      var.synthetic_self_service_max_facilities <= 10000 &&
      floor(var.synthetic_self_service_max_facilities) == var.synthetic_self_service_max_facilities
    )
    error_message = "synthetic_self_service_max_facilities は1〜10000の整数で指定してください。"
  }
}
