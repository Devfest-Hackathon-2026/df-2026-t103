locals {
  # Existing non-PHI status instance in Singapore; never use the US SDK fallback.
  database_url = "https://${var.project_id}-status.asia-southeast1.firebasedatabase.app"
  cors_origins = var.cors_origins != null ? var.cors_origins : "https://${var.project_id}.web.app"

  storage_bucket = var.storage_bucket != "" ? var.storage_bucket : google_storage_bucket.patient_uploads[0].name

  # ランタイム SA（Cloud Run が assume）
  api_sa_email    = google_service_account.api_run.email
  worker_sa_email = google_service_account.worker_run.email

  # Secret Manager で管理する秘密（値は owner が投入。ここでは箱と IAM のみ）
  secret_ids = [
    "SERVER_HMAC_SECRET",
    "INTERNAL_JOB_TOKEN",
    "GOOGLE_PLACES_API_KEY",
    "VERTEX_AI_API_KEY",
  ]
}
