locals {
  location = "australiaeast"
  tags     = { application = "warthog", environment = "delivery", managed_by = "terraform" }
  identities = {
    plan    = "azure-foundation-plan"
    apply   = "azure-foundation-apply"
    images  = "azure-images"
    release = "azure-production"
  }
  state_roles = {
    plan_state  = { identity = "plan", container = "tfstate" }
    plan_plans  = { identity = "plan", container = "plans" }
    apply_state = { identity = "apply", container = "tfstate" }
    apply_plans = { identity = "apply", container = "plans" }
  }
}

resource "azurerm_resource_group" "delivery" {
  name     = "rg-warthog-delivery-aue"
  location = local.location
  tags     = local.tags
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.bootstrap_approved
      error_message = "Review the exact state storage, public HTTPS endpoint, four federated identities and container-scoped grants before bootstrap."
    }
  }
}

# AzAPI avoids listKeys/shared-key output in bootstrap state. This public HTTPS
# endpoint is Entra authenticated; private containers are not private endpoints.
resource "azapi_resource" "state" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  name      = "stwarthogtfauee854"
  parent_id = azurerm_resource_group.delivery.id
  location  = local.location
  tags      = local.tags
  body = {
    kind = "StorageV2"
    sku  = { name = "Standard_LRS" }
    properties = {
      accessTier                   = "Hot"
      minimumTlsVersion            = "TLS1_2"
      supportsHttpsTrafficOnly     = true
      allowBlobPublicAccess        = false
      allowSharedKeyAccess         = false
      defaultToOAuthAuthentication = true
      publicNetworkAccess          = "Enabled"
      networkAcls                  = { defaultAction = "Allow", bypass = "None" }
    }
  }
  lifecycle { prevent_destroy = true }
}

# Azure creates this child with the account. Configure its retention in place;
# trying to create it as azapi_resource fails on a new real storage account.
resource "azapi_update_resource" "blob_service" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"
  resource_id = "${azapi_resource.state.id}/blobServices/default"
  body = {
    properties = {
      isVersioningEnabled            = true
      deleteRetentionPolicy          = { enabled = true, days = 30 }
      containerDeleteRetentionPolicy = { enabled = true, days = 30 }
    }
  }
}

resource "azapi_resource" "container" {
  for_each  = toset(["tfstate", "plans"])
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = each.key
  parent_id = azapi_update_resource.blob_service.id
  body      = { properties = { publicAccess = "None" } }
  lifecycle { prevent_destroy = true }
}

resource "azapi_resource" "plan_retention" {
  type      = "Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01"
  name      = "default"
  parent_id = azapi_resource.state.id
  body = {
    properties = {
      policy = {
        rules = [{
          name    = "expire-private-foundation-plans"
          enabled = true
          type    = "Lifecycle"
          definition = {
            filters = { blobTypes = ["blockBlob"], prefixMatch = ["plans/foundation/"] }
            actions = {
              baseBlob = { delete = { daysAfterModificationGreaterThan = 7 } }
              version  = { delete = { daysAfterCreationGreaterThan = 7 } }
              snapshot = { delete = { daysAfterCreationGreaterThan = 7 } }
            }
          }
        }]
      }
    }
  }
}

resource "azurerm_user_assigned_identity" "delivery" {
  for_each            = local.identities
  name                = "id-warthog-${each.key}-aue"
  resource_group_name = azurerm_resource_group.delivery.name
  location            = local.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github" {
  for_each                  = local.identities
  name                      = "github-${each.value}"
  user_assigned_identity_id = azurerm_user_assigned_identity.delivery[each.key].id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:Orlev01@180486014/warthog@1451921931:environment:${each.value}"
}

# State leases and plan uploads need write access. No workload, subscription,
# key-vault or Owner permission is granted by this initial stage.
resource "azurerm_role_assignment" "state" {
  for_each             = local.state_roles
  scope                = azapi_resource.container[each.value.container].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.delivery[each.value.identity].principal_id
  principal_type       = "ServicePrincipal"
}
