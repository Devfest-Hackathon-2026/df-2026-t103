# Optional portal runtime. No credentials/data roles: BFF forwards user tokens.
# Enable only after Firebase Web/Auth/App Check registration is complete.
variable "hospital_image" {
  type        = string
  default     = null
  description = "Initial validated hospital server image. null leaves the not-yet-configured portal undeployed. CD subsequently updates only the image."
}

variable "hospital_client_config" {
  type = object({
    api_base_url         = string
    firebase_api_key     = string
    firebase_app_id      = string
    firebase_auth_domain = string
    app_check_site_key   = string
  })
  default     = null
  description = "Public Firebase Web/App Check configuration, identical to cd-hospital GitHub Variables. Never supply service-account credentials or debug tokens."
}

resource "google_service_account" "hospital_run" {
  count        = var.hospital_image == null ? 0 : 1
  account_id   = "hospital-run-sa"
  display_name = "Hospital portal (no project data roles)"
}

resource "google_service_account_iam_member" "hospital_deployer_actas" {
  count              = var.hospital_image == null ? 0 : 1
  service_account_id = google_service_account.hospital_run[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_service" "hospital" {
  count    = var.hospital_image == null ? 0 : 1
  name     = "hospital"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.hospital_run[0].email
    max_instance_request_concurrency = 40
    timeout                          = "60s"
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = var.hospital_image
      ports {
        container_port = 8080
      }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = var.hospital_client_config == null ? {} : {
          NODE_ENV                          = "production"
          NEXT_PUBLIC_USE_FIREBASE_EMULATOR = "false"
          NEXT_PUBLIC_FIREBASE_PROJECT_ID   = var.project_id
          NEXT_PUBLIC_API_BASE_URL          = var.hospital_client_config.api_base_url
          NEXT_PUBLIC_FIREBASE_API_KEY      = var.hospital_client_config.firebase_api_key
          NEXT_PUBLIC_FIREBASE_APP_ID       = var.hospital_client_config.firebase_app_id
          NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN  = var.hospital_client_config.firebase_auth_domain
          NEXT_PUBLIC_APP_CHECK_SITE_KEY    = var.hospital_client_config.app_check_site_key
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
    precondition {
      condition     = var.hospital_client_config != null
      error_message = "Hospital deployment requires registered Firebase Web/Auth/App Check settings."
    }
  }
}

# Browser access is public at the transport layer; application auth stays mandatory.
resource "google_cloud_run_v2_service_iam_member" "hospital_browser_invoker" {
  count    = var.hospital_image == null ? 0 : 1
  name     = google_cloud_run_v2_service.hospital[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "hospital_service_uri" {
  value = one(google_cloud_run_v2_service.hospital[*].uri)
}
