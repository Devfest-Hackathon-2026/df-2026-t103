terraform {
  required_version = ">= 1.6"
  backend "gcs" {}
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
variable "project_id" {
  type = string
  validation {
    condition     = var.project_id == "project-7efcc4c4-6c86-490c-ba5"
    error_message = "Only the approved single project is supported."
  }
}
provider "google" {
  project = var.project_id
  region  = "asia-northeast1"
}
# verifyIdToken(token, true) calls GetAccountInfo to reject revoked/disabled users.
# User writes are limited to create/update; no Auth config, password hashes or project-wide Admin role.
resource "google_project_iam_custom_role" "api_auth_read" {
  project = var.project_id
  role_id = "moshimoshiApiAuthRead"
  title   = "Moshimoshi API Firebase Auth user operations"
  permissions = [
    "firebaseauth.users.get",
    "firebaseauth.users.create",
    "firebaseauth.users.update",
  ]
}
resource "google_project_iam_member" "api_auth_read" {
  project = var.project_id
  role    = google_project_iam_custom_role.api_auth_read.name
  member  = "serviceAccount:api-run-sa@${var.project_id}.iam.gserviceaccount.com"
}
