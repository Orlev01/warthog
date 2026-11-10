terraform {
  required_version = ">= 1.16.0, < 2.0.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "5.13.0" }
    azapi   = { source = "Azure/azapi", version = "2.13.0" }
  }
  # Bootstrap cannot depend on the state account it creates. Keep initial state
  # owner-only locally, then migrate to that approved account after validation.
  backend "local" {}
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  tenant_id                       = var.tenant_id
  resource_provider_registrations = "none"
  storage_use_azuread             = true
}

provider "azapi" {
  subscription_id            = var.subscription_id
  tenant_id                  = var.tenant_id
  skip_provider_registration = true
  enable_preflight           = false
  disable_default_output     = true
}
