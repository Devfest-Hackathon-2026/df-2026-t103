# Artifact Registry（API/Worker イメージ格納、Issue #29/#38）

resource "google_artifact_registry_repository" "api" {
  location      = var.region
  repository_id = "api"
  format        = "DOCKER"
  description   = "moshimoshimonshin API container images"
}
