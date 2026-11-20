locals {
  location = "australiaeast"
  tags = {
    application = "warthog"
    environment = "production"
    managed_by  = "terraform"
  }
}

# Security anchors are created by the separately operated access bootstrap.
data "azurerm_resource_group" "warthog" {
  name = var.names.resource_group
}

resource "azurerm_virtual_network" "warthog" {
  name                = var.names.virtual_network
  location            = local.location
  resource_group_name = data.azurerm_resource_group.warthog.name
  address_space       = var.network.address_space
  tags                = local.tags
}

resource "azurerm_subnet" "app" {
  name                 = "container-apps"
  resource_group_name  = data.azurerm_resource_group.warthog.name
  virtual_network_name = azurerm_virtual_network.warthog.name
  address_prefixes     = [var.network.app_subnet]
  service_endpoint {
    service = "Microsoft.Storage"
  }
  service_endpoint {
    service = "Microsoft.KeyVault"
  }
  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "postgres"
  resource_group_name  = data.azurerm_resource_group.warthog.name
  virtual_network_name = azurerm_virtual_network.warthog.name
  address_prefixes     = [var.network.postgres_subnet]
  service_endpoint {
    service = "Microsoft.Storage"
  }
  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "bootstrap" {
  name                 = "private-bootstrap"
  resource_group_name  = data.azurerm_resource_group.warthog.name
  virtual_network_name = azurerm_virtual_network.warthog.name
  address_prefixes     = [var.network.bootstrap_subnet]
  service_endpoint {
    service = "Microsoft.Storage"
  }
  service_endpoint {
    service = "Microsoft.KeyVault"
  }
}

resource "azurerm_network_security_group" "postgres" {
  name                = "warthog-postgres"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.warthog.name
  tags                = local.tags
  security_rule {
    name                       = "AllowReviewedPostgresClients"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefixes    = [var.network.app_subnet, var.network.bootstrap_subnet, var.network.postgres_subnet]
    destination_address_prefix = var.network.postgres_subnet
  }
  security_rule {
    name                       = "DenyOtherPostgresClients"
    priority                   = 200
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefix      = "*"
    destination_address_prefix = var.network.postgres_subnet
  }
}

resource "azurerm_subnet_network_security_group_association" "postgres" {
  subnet_id                 = azurerm_subnet.postgres.id
  network_security_group_id = azurerm_network_security_group.postgres.id
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = var.names.postgres_private_dns
  resource_group_name = data.azurerm_resource_group.warthog.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                 = "warthog"
  private_dns_zone_id  = azurerm_private_dns_zone.postgres.id
  virtual_network_id   = azurerm_virtual_network.warthog.id
  registration_enabled = false
}

resource "azurerm_postgresql_flexible_server" "warthog" {
  name                              = var.names.postgres
  resource_group_name               = data.azurerm_resource_group.warthog.name
  location                          = local.location
  version                           = "16"
  sku_name                          = var.postgres.sku
  zone                              = var.postgres.zone
  storage_mb                        = var.postgres.storage_mb
  storage_type                      = "Premium_LRS"
  storage_tier                      = var.postgres.storage_tier
  auto_grow_enabled                 = false
  backup_retention_days             = var.postgres.backup_retention_days
  geo_redundant_backup_enabled      = false
  administrator_login               = var.postgres.administrator_login
  administrator_password_wo         = var.postgres_admin_password
  administrator_password_wo_version = var.postgres.password_version
  delegated_subnet_id               = azurerm_subnet.postgres.id
  private_dns_zone_id               = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled     = false
  authentication {
    password_auth_enabled         = true
    active_directory_auth_enabled = false
  }
  tags       = local.tags
  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres, azurerm_subnet_network_security_group_association.postgres]
  lifecycle { prevent_destroy = true }
}

data "azurerm_user_assigned_identity" "app" {
  name                = var.names.identity
  resource_group_name = data.azurerm_resource_group.warthog.name
}

resource "azurerm_container_registry" "warthog" {
  name                = var.names.registry
  resource_group_name = data.azurerm_resource_group.warthog.name
  location            = local.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_key_vault" "warthog" {
  name                       = var.names.key_vault
  resource_group_name        = data.azurerm_resource_group.warthog.name
  location                   = local.location
  tenant_id                  = var.tenant_id
  sku_name                   = "premium"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 90
  network_acls {
    bypass                     = "AzureServices"
    default_action             = "Deny"
    virtual_network_subnet_ids = [azurerm_subnet.app.id, azurerm_subnet.bootstrap.id]
  }
  tags = local.tags
  lifecycle { prevent_destroy = true }
}

# AzAPI manages ARM properties without invoking listKeys, so no storage account
# key or Log Analytics shared key is materialized in Terraform state.
resource "azapi_resource" "storage" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  name      = var.names.storage_account
  parent_id = data.azurerm_resource_group.warthog.id
  location  = local.location
  tags      = local.tags
  body = {
    kind = "StorageV2"
    sku  = { name = "Standard_LRS" }
    properties = {
      minimumTlsVersion            = "TLS1_2"
      supportsHttpsTrafficOnly     = true
      allowBlobPublicAccess        = false
      allowSharedKeyAccess         = false
      defaultToOAuthAuthentication = true
      networkAcls = {
        bypass              = "AzureServices"
        defaultAction       = "Deny"
        ipRules             = []
        virtualNetworkRules = [for subnet in [azurerm_subnet.app.id, azurerm_subnet.bootstrap.id] : { id = subnet, action = "Allow" }]
      }
    }
  }
  lifecycle { prevent_destroy = true }
}

resource "azapi_resource" "receipts" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = var.names.receipt_container
  parent_id = "${azapi_resource.storage.id}/blobServices/default"
  body      = { properties = { publicAccess = "None" } }
  lifecycle { prevent_destroy = true }
}

resource "azapi_resource" "logs" {
  type      = "Microsoft.OperationalInsights/workspaces@2022-10-01"
  name      = var.names.logs
  parent_id = data.azurerm_resource_group.warthog.id
  location  = local.location
  tags      = local.tags
  body = {
    properties = {
      sku              = { name = "PerGB2018" }
      retentionInDays  = 30
      workspaceCapping = { dailyQuotaGb = var.log_daily_cap_gb }
      features         = { disableLocalAuth = true, enableLogAccessUsingOnlyResourcePermissions = true }
    }
  }
}

resource "azapi_resource" "environment" {
  type      = "Microsoft.App/managedEnvironments@2025-01-01"
  name      = var.names.container_environment
  parent_id = data.azurerm_resource_group.warthog.id
  location  = local.location
  tags      = local.tags
  body = {
    properties = {
      appLogsConfiguration = { destination = "azure-monitor" }
      vnetConfiguration    = { infrastructureSubnetId = azurerm_subnet.app.id, internal = false }
      workloadProfiles     = [{ name = "Consumption", workloadProfileType = "Consumption" }]
    }
  }
}

resource "azurerm_monitor_diagnostic_setting" "environment" {
  name                       = "warthog-environment"
  target_resource_id         = azapi_resource.environment.id
  log_analytics_workspace_id = azapi_resource.logs.id
  enabled_log { category = "ContainerAppConsoleLogs" }
  enabled_log { category = "ContainerAppSystemLogs" }
}

resource "azurerm_role_assignment" "registry_pull" {
  scope                = azurerm_container_registry.warthog.id
  role_definition_name = "AcrPull"
  principal_id         = data.azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "receipt_data" {
  scope                = azapi_resource.receipts.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_user_assigned_identity.app.principal_id
}

# The same vault holds operator-only bootstrap passwords. The application may
# retrieve only its versioned runtime secrets, never the administrator password,
# raw database passwords or the delivery ownership connection.
#
# linkedin-client-secret is optional (docs/linkedin-launch.md): plan and apply
# this only AFTER `runner.py install-secret` has written it, because a grant
# can't be scoped to a secret that doesn't exist yet.
resource "azurerm_role_assignment" "secrets" {
  for_each = toset([
    "database-url", "migration-database-url", "purge-database-url",
    "warthog-hmac-key", "resend-api-key", "twilio-account-sid",
    "twilio-api-key-sid", "twilio-api-key-secret", "google-client-secret",
    "microsoft-client-secret", "google-early-access", "vapid-private-key",
    "linkedin-client-secret",
  ])
  scope                = "${azurerm_key_vault.warthog.id}/secrets/${each.key}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = data.azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "key_wrapping" {
  scope                = "${azurerm_key_vault.warthog.id}/keys/warthog-wrap"
  role_definition_name = "Key Vault Crypto Service Encryption User"
  principal_id         = data.azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_consumption_budget_subscription" "warthog" {
  name            = "warthog-approved-notifications"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.monthly_azure_budget_aud
  time_grain      = "Monthly"
  time_period {
    start_date = var.budget_start_date
    end_date   = var.budget_end_date
  }
  dynamic "notification" {
    for_each = { actual50 = [50, "Actual"], actual80 = [80, "Actual"], actual100 = [100, "Actual"], forecast100 = [100, "Forecasted"] }
    content {
      enabled        = true
      operator       = "GreaterThan"
      threshold      = notification.value[0]
      threshold_type = notification.value[1]
      contact_emails = var.alert_emails
    }
  }
}

# Adopt the founder-authorized alert created before the foundation exists.
# This only reads during plan; applying the reviewed plan records it in state.
import {
  for_each = var.import_existing_budget ? toset(["warthog"]) : toset([])
  to       = azurerm_consumption_budget_subscription.warthog
  id       = "/subscriptions/${var.subscription_id}/providers/Microsoft.Consumption/budgets/warthog-approved-notifications"
}
