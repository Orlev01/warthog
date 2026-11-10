output "delivery" {
  description = "Nonsecret identifiers only; copy settings privately after approved creation."
  value = {
    backend = {
      resource_group_name  = azurerm_resource_group.delivery.name
      storage_account_name = azapi_resource.state.name
      container_name       = "tfstate"
      key                  = "production.tfstate"
    }
    plan_storage_account = azapi_resource.state.name
    plan_container       = "plans"
    environment_client_ids = {
      for key, environment in local.identities : environment => azurerm_user_assigned_identity.delivery[key].client_id
    }
  }
}
