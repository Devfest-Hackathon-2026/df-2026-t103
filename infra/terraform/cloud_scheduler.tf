# Cloud Scheduler（Issue #31）
# worker 内部エンドポイントを OIDC で叩く。重複実行はワーカー側のリース/冪等で防ぐ。

locals {
  worker_url = google_cloud_run_v2_service.worker.uri
}

resource "google_cloud_scheduler_job" "deletion_scan" {
  name      = "deletion-scan"
  region    = var.region
  schedule  = "0 * * * *" # 毎時
  time_zone = "Asia/Tokyo"

  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "${local.worker_url}/v1/internal/jobs/deletion-scan"

    oidc_token {
      service_account_email = google_service_account.jobs_invoker.email
      audience              = local.worker_url
    }
  }
}

resource "google_cloud_scheduler_job" "upload_expiry_scan" {
  name      = "upload-expiry-scan"
  region    = var.region
  schedule  = "*/15 * * * *" # 15分毎
  time_zone = "Asia/Tokyo"

  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "${local.worker_url}/v1/internal/jobs/upload-expiry-scan"

    oidc_token {
      service_account_email = google_service_account.jobs_invoker.email
      audience              = local.worker_url
    }
  }
}
