# Human access is empty until real Cloud Identity groups are supplied.
# Do not invent email addresses or grant runtime access to human operators.
variable "operator_groups" {
  description = "Verified group:<address> principals for operations, audit and security; no defaults grant human access."
  type = object({
    operations = set(string)
    audit      = set(string)
    security   = set(string)
  })
  default = { operations = [], audit = [], security = [] }
  validation {
    condition = alltrue([
      for member in concat(tolist(var.operator_groups.operations), tolist(var.operator_groups.audit), tolist(var.operator_groups.security)) :
      can(regex("^group:[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", member))
    ])
    error_message = "Use only existing, verified Cloud Identity group:<address> principals."
  }
}

resource "google_logging_project_bucket_config" "operator_audit" {
  project        = var.project_id
  location       = var.region
  bucket_id      = "operator-audit"
  retention_days = 400
  # No irreversible retention lock. Review before any future retention reduction.
  lifecycle { prevent_destroy = true }
}

resource "google_logging_log_view" "operator_audit" {
  parent      = "projects/${var.project_id}"
  location    = var.region
  bucket      = google_logging_project_bucket_config.operator_audit.bucket_id
  name        = "security-audit"
  description = "Application audit events and Google Cloud audit logs only"
  filter      = "SOURCE(\"projects/${var.project_id}\")"
}

resource "google_logging_project_sink" "operator_audit" {
  project                = var.project_id
  name                   = "operator-audit"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.operator_audit.id}"
  filter                 = "jsonPayload.auditEvent:* OR logName:cloudaudit.googleapis.com"
  unique_writer_identity = true
}

resource "google_logging_log_view_iam_member" "audit_reader" {
  for_each = setunion(var.operator_groups.audit, var.operator_groups.security)
  parent   = "projects/${var.project_id}"
  location = var.region
  bucket   = google_logging_project_bucket_config.operator_audit.bucket_id
  name     = google_logging_log_view.operator_audit.name
  role     = "roles/logging.viewAccessor"
  member   = each.value
}

resource "google_project_iam_member" "operations_monitoring" {
  for_each = var.operator_groups.operations
  project  = var.project_id
  role     = "roles/monitoring.viewer"
  member   = each.value
}

resource "google_project_iam_member" "security_review" {
  for_each = var.operator_groups.security
  project  = var.project_id
  role     = "roles/iam.securityReviewer"
  member   = each.value
}
