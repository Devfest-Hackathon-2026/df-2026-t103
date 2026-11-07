terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # 状態は GCS バックエンドで管理する（owner がバケットを用意して有効化）。
  # バケット未確定の間は -backend=false で validate/fmt のみ可能。
  # backend "gcs" {
  #   bucket = "PROJECT_ID-tfstate"
  #   prefix = "infra"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
