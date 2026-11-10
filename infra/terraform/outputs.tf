output "api_service_uri" {
  description = "API Cloud Run サービスの URL"
  value       = google_cloud_run_v2_service.api.uri
}

output "worker_service_uri" {
  description = "Worker Cloud Run サービスの URL（内部）"
  value       = google_cloud_run_v2_service.worker.uri
}

output "api_runtime_sa" {
  value = google_service_account.api_run.email
}

output "worker_runtime_sa" {
  value = google_service_account.worker_run.email
}

output "deployer_sa" {
  description = "WIF で GitHub Actions が assume するデプロイ SA（#38）"
  value       = google_service_account.github_deployer.email
}

output "artifact_registry_repo" {
  value = google_artifact_registry_repository.api.name
}
