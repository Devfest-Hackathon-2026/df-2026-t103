# Cloud Tasks キュー（Issue #31）
# maxAttempts で DLQ 相当の打ち切り、maxConcurrentDispatches で費用急増抑制（§11.2）。

resource "google_cloud_tasks_queue" "ocr" {
  name     = "ocr"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 10
    max_dispatches_per_second = 5
  }
  retry_config {
    max_attempts = 5
    min_backoff  = "10s"
    max_backoff  = "300s"
  }
}

resource "google_cloud_tasks_queue" "delivery" {
  name     = "delivery"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 20
    max_dispatches_per_second = 10
  }
  retry_config {
    max_attempts = 8
    min_backoff  = "10s"
    max_backoff  = "300s"
  }
}

resource "google_cloud_tasks_queue" "deletion_retry" {
  name     = "deletion-retry"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 10
    max_dispatches_per_second = 5
  }
  retry_config {
    max_attempts = 5
    min_backoff  = "10s"
    max_backoff  = "300s"
  }
}
