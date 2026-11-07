# Firestore 本番設定（Issue #35）
# Native・東京・PITR・日次バックアップ。rules/indexes は firebase CLI/CD（#38）が管理。

resource "google_firestore_database" "default" {
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
}

resource "google_firestore_backup_schedule" "daily" {
  database = google_firestore_database.default.name

  # 保持 7 日
  retention = "604800s"

  daily_recurrence {}
}
