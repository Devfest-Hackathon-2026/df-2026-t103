# Cloud Run v2 サービス（Issue #29 api / #31 worker）
# image は CD（#38）が差し替えるため ignore_changes。env/secret/スケーリングが正本。

resource "google_cloud_run_v2_service" "api" {
  name     = "api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = local.api_sa_email
    max_instance_request_concurrency = 80
    timeout                          = "300s"

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    containers {
      image = var.api_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # リクエスト処理中のみ CPU（min=0 と整合）
        startup_cpu_boost = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "FIREBASE_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "FIREBASE_STORAGE_BUCKET"
        value = local.storage_bucket
      }
      env {
        name  = "APP_CHECK_MODE"
        value = "enforce"
      }
      env {
        name  = "API_DOCS_ENABLED"
        value = "false"
      }
      env {
        name  = "API_CORS_ORIGINS"
        value = var.cors_origins
      }
      env {
        name  = "OCR_TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "OCR_TASKS_QUEUE"
        value = google_cloud_tasks_queue.ocr.name
      }
      env {
        name  = "VERTEX_AI_LOCATION"
        value = var.region
      }

      dynamic "env" {
        for_each = toset(["SERVER_HMAC_SECRET", "INTERNAL_JOB_TOKEN", "GOOGLE_PLACES_API_KEY", "VERTEX_AI_API_KEY"])
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_secret_manager_secret_iam_member.accessor]
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "worker"
  location = var.region
  # 非公開（Scheduler/Tasks からの OIDC 呼び出しのみ想定）
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account                  = local.worker_sa_email
    max_instance_request_concurrency = 8
    timeout                          = "600s"

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = var.api_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "FIREBASE_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "FIREBASE_STORAGE_BUCKET"
        value = local.storage_bucket
      }
      env {
        name  = "OCR_TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "OCR_TASKS_QUEUE"
        value = google_cloud_tasks_queue.ocr.name
      }
      env {
        name  = "VERTEX_AI_LOCATION"
        value = var.region
      }

      dynamic "env" {
        for_each = toset(["SERVER_HMAC_SECRET", "INTERNAL_JOB_TOKEN", "VERTEX_AI_API_KEY"])
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_secret_manager_secret_iam_member.accessor]
}
