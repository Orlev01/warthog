# New retention and access scope: apply only after the founder reviews the exact
# plan. This journal must never be rolled back with the database or receipt blobs.
resource "azapi_update_resource" "blob_recovery" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"
  resource_id = "${azapi_resource.storage.id}/blobServices/default"
  body = {
    properties = {
      isVersioningEnabled            = true
      deleteRetentionPolicy          = { enabled = true, days = var.postgres.backup_retention_days + 7, allowPermanentDelete = false }
      containerDeleteRetentionPolicy = { enabled = true, days = var.postgres.backup_retention_days + 7 }
    }
  }
}

resource "azapi_resource" "deletion_journal" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = "account-deletions"
  parent_id = "${azapi_resource.storage.id}/blobServices/default"
  body      = { properties = { publicAccess = "None" } }
  lifecycle { prevent_destroy = true }
}

resource "azurerm_storage_container_immutability_policy" "deletion_journal" {
  storage_container_resource_manager_id = azapi_resource.deletion_journal.id
  immutability_period_in_days           = 42
  locked                                = true
  protected_append_writes_enabled       = false
  protected_append_writes_all_enabled   = false
  lifecycle { prevent_destroy = true }
}

# Lifecycle Delete is unsupported on immutable containers. Journal evidence is
# retained until separately reviewed operator cleanup; do not promise auto-expiry.
# Receipt history is not immutable and can use the normal lifecycle service.
resource "azapi_resource" "journal_retention" {
  type      = "Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01"
  name      = "default"
  parent_id = azapi_resource.storage.id
  body = {
    properties = {
      policy = {
        rules = [{
          name    = "expire-old-receipt-versions"
          enabled = true
          type    = "Lifecycle"
          definition = {
            filters = { blobTypes = ["blockBlob"], prefixMatch = ["${var.names.receipt_container}/"] }
            actions = { version = { delete = { daysAfterCreationGreaterThan = var.postgres.backup_retention_days + 7 } } }
          }
        }]
      }
    }
  }
}

# Defined by the separately approved security-anchor module; the lower-privilege
# foundation identity can assign it only to the application's existing identity.
resource "azurerm_role_assignment" "deletion_journal_writer" {
  scope              = azapi_resource.deletion_journal.id
  role_definition_id = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/bd073ecf-ecb9-5398-ad82-39d1947b034c"
  principal_id       = data.azurerm_user_assigned_identity.app.principal_id
}
