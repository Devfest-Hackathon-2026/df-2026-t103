# サービスアカウント（Issue #29/#31）

resource "google_service_account" "api_run" {
  account_id   = "api-run-sa"
  display_name = "moshimoshimonshin API (Cloud Run runtime)"
}

resource "google_service_account" "worker_run" {
  account_id   = "worker-run-sa"
  display_name = "moshimoshimonshin Worker (Cloud Run runtime, internal)"
}

resource "google_service_account" "github_deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions deployer (WIF, #38 CD)"
}

resource "google_service_account" "jobs_invoker" {
  account_id   = "jobs-invoker"
  display_name = "Scheduler/Tasks OIDC invoker"
}
