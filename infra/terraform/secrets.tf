# Secret Manager（Issue #32）
# 箱と IAM のみ。実値（バージョン）は owner が infra/secret-manager/setup-secrets.sh
# 相当の手順で投入する（Terraform に秘密値を書かない）。

resource "google_secret_manager_secret" "secrets" {
  for_each  = toset(local.secret_ids)
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

# ランタイム SA にのみ secretAccessor をシークレット単位で付与（最小権限）
locals {
  secret_access = {
    for pair in setproduct(local.secret_ids, keys(local.runtime_sas)) :
    "${pair[0]}-${pair[1]}" => { secret = pair[0], sa = local.runtime_sas[pair[1]] }
    if pair[0] != "VERTEX_AI_API_KEY"
  }
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each  = local.secret_access
  secret_id = google_secret_manager_secret.secrets[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.sa}"
}
