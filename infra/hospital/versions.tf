terraform {
  required_version = ">= 1.6"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
}
variable "project_id" {
  type = string
  validation {
    condition     = var.project_id == "project-7efcc4c4-6c86-490c-ba5"
    error_message = "Only the approved single project is supported."
  }
}
variable "region" {
  type    = string
  default = "asia-northeast1"
  validation {
    condition     = var.region == "asia-northeast1"
    error_message = "Hospital runtime must stay in Tokyo."
  }
}
variable "deployer_sa_email" {
  type        = string
  description = "Existing WIF deployer; this root grants actAs only on the new hospital SA."
}
