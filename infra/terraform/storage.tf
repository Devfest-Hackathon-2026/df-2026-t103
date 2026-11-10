# Raw uploaded images only; never reuse a shared/default bucket implicitly.
resource "google_storage_bucket" "patient_uploads" {
  count                       = var.storage_bucket == "" ? 1 : 0
  project                     = var.project_id
  name                        = "${var.project_id}-patient-uploads"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 604800 }

  cors {
    origin          = ["https://${var.project_id}.web.app"]
    method          = ["PUT"]
    response_header = ["Content-Type", "x-goog-if-generation-match"]
    max_age_seconds = 300
  }

  # Preserve the current API's 30-day upload TTL, then one day of safety margin.
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age            = 31
      matches_prefix = ["patient-uploads/"]
    }
  }

  lifecycle { prevent_destroy = true }
}
