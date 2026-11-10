terraform {
  required_version = ">= 1.16.0, < 2.0.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "5.13.0" }
    azapi   = { source = "Azure/azapi", version = "2.13.0" }
  }
  backend "local" {}
}

provider "azurerm" {
  features {}
  subscription_id                 = local.subscription
  tenant_id                       = "72277873-e056-4612-9b1c-7ad58e02fcf3"
  resource_provider_registrations = "none"
}

variable "access_approved" {
  type    = bool
  default = false
  validation {
    condition     = var.access_approved
    error_message = "Delivery permission setup requires founder authorization."
  }
}

variable "registry_ready" {
  type    = bool
  default = false
}

variable "operator_principal_id" {
  type        = string
  description = "Verified personal operator; grants access only to the Terraform state container."
  validation {
    condition     = can(regex("^[a-f0-9-]{36}$", var.operator_principal_id))
    error_message = "Supply the verified personal operator object ID."
  }
}

locals {
  subscription = "e854f594-274f-4051-841b-78df7655d73c"
  scope        = "/subscriptions/${local.subscription}"
  budget       = "${local.scope}/providers/Microsoft.Consumption/budgets/warthog-approved-notifications"
  tags         = { application = "warthog", environment = "production", managed_by = "terraform" }
  data_roles = [
    "7f951dda-4ed3-4680-a7ca-43fe172d538d", # AcrPull
    "ba92f5b4-2d11-453d-a403-e96b0029c9fe", # Storage Blob Data Contributor
    "4633458b-17de-408a-b874-0445c86b69e6", # Key Vault Secrets User
    "e147488a-f6f5-4113-8e2d-b22465e65bf6", # Key Vault Crypto Service Encryption User
  ]
}

# Own these security anchors outside the lower-privilege foundation state.
resource "azurerm_resource_group" "production" {
  name     = "rg-warthog-prod-aue"
  location = "australiaeast"
  tags     = local.tags
  lifecycle { prevent_destroy = true }
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-warthog-app-aue"
  resource_group_name = azurerm_resource_group.production.name
  location            = azurerm_resource_group.production.location
  tags                = local.tags
  lifecycle { prevent_destroy = true }
}

data "azurerm_user_assigned_identity" "delivery" {
  for_each            = toset(["plan", "apply", "images", "release"])
  name                = "id-warthog-${each.key}-aue"
  resource_group_name = "rg-warthog-delivery-aue"
}

resource "azurerm_role_assignment" "plan" {
  scope                = azurerm_resource_group.production.id
  role_definition_name = "Reader"
  principal_id         = data.azurerm_user_assigned_identity.delivery["plan"].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_definition" "foundation" {
  name  = "Warthog foundation resources"
  scope = azurerm_resource_group.production.id
  permissions {
    # No resource deletion, user-assigned identity/federation writes, arbitrary
    # compute, app deployment, provider registration or public DNS zone writes.
    actions = [
      "*/read",
      "Microsoft.Network/virtualNetworks/write",
      "Microsoft.Network/virtualNetworks/subnets/write",
      "Microsoft.Network/virtualNetworks/subnets/join/action",
      "Microsoft.Network/networkSecurityGroups/write",
      "Microsoft.Network/networkSecurityGroups/join/action",
      "Microsoft.Network/privateDnsZones/write",
      "Microsoft.Network/privateDnsZones/join/action",
      "Microsoft.Network/privateDnsZones/virtualNetworkLinks/write",
      "Microsoft.DBforPostgreSQL/flexibleServers/write",
      "Microsoft.ContainerRegistry/registries/write",
      "Microsoft.KeyVault/vaults/write",
      "Microsoft.Storage/storageAccounts/write",
      "Microsoft.Storage/storageAccounts/blobServices/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/write",
      "Microsoft.OperationalInsights/workspaces/write",
      "Microsoft.App/managedEnvironments/write",
      "Microsoft.Insights/diagnosticSettings/write",
    ]
  }
  assignable_scopes = [azurerm_resource_group.production.id]
}

resource "azurerm_role_assignment" "foundation" {
  scope              = azurerm_resource_group.production.id
  role_definition_id = azurerm_role_definition.foundation.role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.delivery["apply"].principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_definition" "app_grants" {
  name  = "Warthog constrained application grants"
  scope = azurerm_resource_group.production.id
  permissions {
    actions = ["Microsoft.Authorization/roleAssignments/read", "Microsoft.Authorization/roleAssignments/write", "Microsoft.Authorization/roleDefinitions/read"]
  }
  assignable_scopes = [azurerm_resource_group.production.id]
}

resource "azurerm_role_assignment" "app_grants" {
  scope              = azurerm_resource_group.production.id
  role_definition_id = azurerm_role_definition.app_grants.role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.delivery["apply"].principal_id
  principal_type     = "ServicePrincipal"
  condition_version  = "2.0"
  condition          = "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${join(", ", local.data_roles)}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${azurerm_user_assigned_identity.app.principal_id}}))"
}

resource "azurerm_role_definition" "budget" {
  for_each = toset(["plan", "apply"])
  name     = "Warthog budget ${each.key}"
  scope    = local.scope
  permissions {
    actions = each.key == "plan" ? ["Microsoft.Consumption/budgets/read"] : ["Microsoft.Consumption/budgets/read", "Microsoft.Consumption/budgets/write"]
  }
  assignable_scopes = [local.scope]
}

resource "azurerm_role_assignment" "budget" {
  for_each           = toset(["plan", "apply"])
  scope              = local.budget
  role_definition_id = azurerm_role_definition.budget[each.key].role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.delivery[each.key].principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_definition" "release" {
  name  = "Warthog application release"
  scope = azurerm_resource_group.production.id
  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/deployments/read",
      "Microsoft.Resources/deployments/write",
      "Microsoft.Resources/deployments/validate/action",
      "Microsoft.Resources/deployments/operations/read",
      "Microsoft.Resources/deployments/operationStatuses/read",
      "Microsoft.App/managedEnvironments/read",
      "Microsoft.App/managedEnvironments/join/action",
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/write",
      "Microsoft.App/containerApps/revisions/read",
      "Microsoft.App/containerApps/revisions/activate/action",
      "Microsoft.App/containerApps/revisions/deactivate/action",
      "Microsoft.App/containerApps/revisions/replicas/read",
    ]
  }
  assignable_scopes = [azurerm_resource_group.production.id]
}

resource "azurerm_role_assignment" "release" {
  scope              = azurerm_resource_group.production.id
  role_definition_id = azurerm_role_definition.release.role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.delivery["release"].principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "release_identity" {
  scope                = azurerm_user_assigned_identity.app.id
  role_definition_name = "Managed Identity Operator"
  principal_id         = data.azurerm_user_assigned_identity.delivery["release"].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "registry" {
  for_each             = var.registry_ready ? { images = "AcrPush", release = "AcrPull" } : {}
  scope                = "${azurerm_resource_group.production.id}/providers/Microsoft.ContainerRegistry/registries/crwarthogprodauee854"
  role_definition_name = each.value
  principal_id         = data.azurerm_user_assigned_identity.delivery[each.key].principal_id
  principal_type       = "ServicePrincipal"
}

output "app_identity_id" { value = azurerm_user_assigned_identity.app.id }

resource "azurerm_role_assignment" "operator_state" {
  scope                = "${local.scope}/resourceGroups/rg-warthog-delivery-aue/providers/Microsoft.Storage/storageAccounts/stwarthogtfauee854/blobServices/default/containers/tfstate"
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.operator_principal_id
  principal_type       = "User"
}

# This identity can remove expired runner leases; it cannot provision a VM,
# read application secrets or deploy a workload. Its environment permits trusted
# main only and deliberately requires no human approval for cost-saving cleanup.
resource "azurerm_user_assigned_identity" "cleanup" {
  name                = "id-warthog-runner-cleanup-aue"
  resource_group_name = "rg-warthog-delivery-aue"
  location            = "australiaeast"
  tags                = { application = "warthog", environment = "delivery", managed_by = "terraform" }
}
resource "azurerm_federated_identity_credential" "cleanup" {
  name                      = "github-runner-cleanup"
  user_assigned_identity_id = azurerm_user_assigned_identity.cleanup.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:Orlev01@180486014/warthog@1451921931:environment:azure-runner-cleanup"
}
resource "azurerm_role_definition" "runner_discovery" {
  name  = "Warthog runner group discovery"
  scope = local.scope
  permissions { actions = ["Microsoft.Resources/subscriptions/resourceGroups/read"] }
  assignable_scopes = [local.scope]
}
resource "azurerm_role_assignment" "runner_discovery" {
  scope              = local.scope
  role_definition_id = azurerm_role_definition.runner_discovery.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.cleanup.principal_id
  principal_type     = "ServicePrincipal"
}
resource "azurerm_role_definition" "runner_delete" {
  name  = "Warthog expired runner deletion"
  scope = local.scope
  permissions { actions = ["Microsoft.Resources/subscriptions/resourceGroups/read", "Microsoft.Resources/subscriptions/resourceGroups/delete"] }
  assignable_scopes = [local.scope]
  # Assigned ONLY inside each temporary runner group, by infra/runner.
}
variable "private_network_ready" {
  type    = bool
  default = false
}
resource "azurerm_role_definition" "runner_network_cleanup" {
  name  = "Warthog runner subnet cleanup"
  scope = azurerm_resource_group.production.id
  permissions { actions = ["Microsoft.Network/virtualNetworks/subnets/read", "Microsoft.Network/virtualNetworks/subnets/write"] }
  assignable_scopes = [azurerm_resource_group.production.id]
}
resource "azurerm_role_assignment" "runner_network_cleanup" {
  count              = var.private_network_ready ? 1 : 0
  scope              = "${azurerm_resource_group.production.id}/providers/Microsoft.Network/virtualNetworks/vnet-warthog-prod-aue/subnets/private-bootstrap"
  role_definition_id = azurerm_role_definition.runner_network_cleanup.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.cleanup.principal_id
  principal_type     = "ServicePrincipal"
}
output "cleanup" {
  value = { client_id = azurerm_user_assigned_identity.cleanup.client_id, principal_id = azurerm_user_assigned_identity.cleanup.principal_id }
}

# Founder-only data-plane setup/rotation, still subject to the vault's private
# subnet firewall. Delivery OIDC principals do not receive these permissions.
resource "azurerm_role_assignment" "operator_vault" {
  for_each             = var.private_network_ready ? toset(["Key Vault Secrets Officer", "Key Vault Crypto Officer"]) : toset([])
  scope                = "${azurerm_resource_group.production.id}/providers/Microsoft.KeyVault/vaults/kv-warthog-aue-e854"
  role_definition_name = each.key
  principal_id         = var.operator_principal_id
  principal_type       = "User"
}

resource "azurerm_role_definition" "foundation_metadata" {
  name  = "Warthog foundation provider metadata"
  scope = local.scope
  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/read",
      "Microsoft.Resources/subscriptions/providers/read",
      "Microsoft.Resources/subscriptions/locations/read",
      "Microsoft.Authorization/roleDefinitions/read",
    ]
  }
  assignable_scopes = [local.scope]
}
resource "azurerm_role_assignment" "foundation_metadata" {
  for_each           = toset(["plan", "apply"])
  scope              = local.scope
  role_definition_id = azurerm_role_definition.foundation_metadata.role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.delivery[each.key].principal_id
  principal_type     = "ServicePrincipal"
}

provider "azapi" {
  subscription_id            = local.subscription
  tenant_id                  = "72277873-e056-4612-9b1c-7ad58e02fcf3"
  skip_provider_registration = true
  disable_default_output     = true
}
resource "azapi_resource" "runner_locks" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = "runner-locks"
  parent_id = "${local.scope}/resourceGroups/rg-warthog-delivery-aue/providers/Microsoft.Storage/storageAccounts/stwarthogtfauee854/blobServices/default"
  body      = { properties = { publicAccess = "None" } }
}
resource "azurerm_role_assignment" "runner_locks" {
  for_each             = { operator = var.operator_principal_id, cleanup = azurerm_user_assigned_identity.cleanup.principal_id }
  scope                = azapi_resource.runner_locks.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
  principal_type       = each.key == "operator" ? "User" : "ServicePrincipal"
}
