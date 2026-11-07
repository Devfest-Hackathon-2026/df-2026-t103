# 最小権限 IAM（Issue #29/#31）

# --- ランタイム SA（api/worker 共通の最小権限）---
locals {
  runtime_sas = {
    api    = google_service_account.api_run.email
    worker = google_service_account.worker_run.email
  }
  runtime_roles = [
    "roles/datastore.user",      # Firestore 読み書き
    "roles/cloudtasks.enqueuer", # Cloud Tasks 投入
  ]
  # (sa, role) の直積
  runtime_bindings = {
    for pair in setproduct(keys(local.runtime_sas), local.runtime_roles) :
    "${pair[0]}-${pair[1]}" => { sa = local.runtime_sas[pair[0]], role = pair[1] }
  }
}

resource "google_project_iam_member" "runtime" {
  for_each = local.runtime_bindings
  project  = var.project_id
  role     = each.value.role
  member   = "serviceAccount:${each.value.sa}"
}

# Storage は対象バケット単位で付与（project 全体ではなく絞る）
resource "google_storage_bucket_iam_member" "runtime_storage" {
  for_each = local.runtime_sas
  bucket   = local.storage_bucket
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${each.value}"
}

# --- デプロイ SA（WIF, #38 CD）---
resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/firebasehosting.admin",
    "roles/datastore.owner",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

# デプロイ SA がランタイム SA を actAs（deploy 時に必要）
resource "google_service_account_iam_member" "deployer_actas" {
  for_each           = local.runtime_sas
  service_account_id = each.key == "api" ? google_service_account.api_run.name : google_service_account.worker_run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}

# --- OIDC invoker（Scheduler/Tasks → worker を呼ぶ）---
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloud_run_v2_service.worker.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.jobs_invoker.email}"
}
