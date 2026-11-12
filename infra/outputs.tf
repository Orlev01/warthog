output "foundation" {
  description = "Nonsecret identifiers for the separately approved bootstrap and workload stages. No secret values or connection strings."
  value = {
    resource_group              = data.azurerm_resource_group.warthog.name
    environment_id              = azapi_resource.environment.id
    identity_id                 = data.azurerm_user_assigned_identity.app.id
    azure_client_id             = data.azurerm_user_assigned_identity.app.client_id
    registry_login_server       = azurerm_container_registry.warthog.login_server
    postgres_fqdn               = azurerm_postgresql_flexible_server.warthog.fqdn
    private_bootstrap_subnet_id = azurerm_subnet.bootstrap.id
    key_vault_url               = azurerm_key_vault.warthog.vault_uri
    storage_account             = var.names.storage_account
    storage_container           = var.names.receipt_container
    deletion_journal_container  = azapi_resource.deletion_journal.name
    logs_workspace_id           = azapi_resource.logs.id
  }
}
