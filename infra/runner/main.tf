terraform {
  required_version = ">= 1.16.0, < 2.0.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "5.13.0" }
  }
  backend "local" {}
}
provider "azurerm" {
  features {}
  subscription_id                 = "e854f594-274f-4051-841b-78df7655d73c"
  tenant_id                       = "72277873-e056-4612-9b1c-7ad58e02fcf3"
  resource_provider_registrations = "none"
}
variable "lease_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{10,14}$", var.lease_id))
    error_message = "Use the exact approved GitHub run ID or timestamp for a connectivity rehearsal."
  }
}
variable "expires_at" {
  type = string
  validation {
    condition     = can(timeadd(var.expires_at, "0h"))
    error_message = "Supply an explicit UTC lease expiry, at most four hours after creation."
  }
}
variable "ssh_public_key" { type = string }
variable "ubuntu_version" {
  type = string
  validation {
    condition     = var.ubuntu_version != "latest" && can(regex("^[0-9.]+$", var.ubuntu_version))
    error_message = "Pin the inspected Canonical Ubuntu image version."
  }
}
locals {
  subnet = "/subscriptions/e854f594-274f-4051-841b-78df7655d73c/resourceGroups/rg-warthog-prod-aue/providers/Microsoft.Network/virtualNetworks/vnet-warthog-prod-aue/subnets/private-bootstrap"
  tags   = { application = "warthog", environment = "delivery", managed_by = "terraform", purpose = "ephemeral-runner", expires_at = var.expires_at, lease_id = var.lease_id }
}
resource "azurerm_resource_group" "runner" {
  name     = "rg-warthog-runner-${var.lease_id}"
  location = "australiaeast"
  tags     = local.tags
}
resource "azurerm_public_ip" "egress" {
  name                = "runner-egress"
  resource_group_name = azurerm_resource_group.runner.name
  location            = azurerm_resource_group.runner.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}
resource "azurerm_nat_gateway" "runner" {
  name                = "runner-egress"
  resource_group_name = azurerm_resource_group.runner.name
  location            = azurerm_resource_group.runner.location
  sku_name            = "Standard"
  tags                = local.tags
}
resource "azurerm_nat_gateway_public_ip_association" "runner" {
  nat_gateway_id       = azurerm_nat_gateway.runner.id
  public_ip_address_id = azurerm_public_ip.egress.id
}
resource "azurerm_subnet_nat_gateway_association" "runner" {
  subnet_id      = local.subnet
  nat_gateway_id = azurerm_nat_gateway.runner.id
}
resource "azurerm_network_security_group" "runner" {
  name                = "runner-no-inbound"
  resource_group_name = azurerm_resource_group.runner.name
  location            = azurerm_resource_group.runner.location
  tags                = local.tags
  security_rule {
    name                       = "DenyAllInbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}
resource "azurerm_network_interface" "runner" {
  name                = "runner-private"
  resource_group_name = azurerm_resource_group.runner.name
  location            = azurerm_resource_group.runner.location
  tags                = local.tags
  ip_configuration {
    name                          = "private"
    subnet_id                     = local.subnet
    private_ip_address_allocation = "Dynamic"
  }
}
resource "azurerm_network_interface_security_group_association" "runner" {
  network_interface_id      = azurerm_network_interface.runner.id
  network_security_group_id = azurerm_network_security_group.runner.id
}
resource "azurerm_linux_virtual_machine" "runner" {
  name                            = "warthog-runner"
  resource_group_name             = azurerm_resource_group.runner.name
  location                        = azurerm_resource_group.runner.location
  size                            = "Standard_B2s"
  admin_username                  = "runner"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.runner.id]
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  tags                            = local.tags
  admin_ssh_key {
    username   = "runner"
    public_key = var.ssh_public_key
  }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 32
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = var.ubuntu_version
  }
  # No managed identity, cloud-init secrets, public NIC address or inbound ports.
  depends_on = [azurerm_subnet_nat_gateway_association.runner, azurerm_nat_gateway_public_ip_association.runner, azurerm_network_interface_security_group_association.runner]
}
# Independent Azure shutdown limits compute exposure if the controller disappears.
# External cleanup must still delete the disk, NAT and IP; shutdown alone is not cleanup.
resource "azurerm_dev_test_global_vm_shutdown_schedule" "runner" {
  virtual_machine_id    = azurerm_linux_virtual_machine.runner.id
  location              = azurerm_resource_group.runner.location
  enabled               = true
  daily_recurrence_time = formatdate("hhmm", var.expires_at)
  timezone              = "UTC"
  notification_settings { enabled = false }
  tags = local.tags
}
output "runner" {
  value = { resource_group = azurerm_resource_group.runner.name, vm_id = azurerm_linux_virtual_machine.runner.id, subnet_id = local.subnet }
}

variable "cleanup_principal_id" { type = string }
data "azurerm_role_definition" "cleanup" {
  name  = "Warthog expired runner deletion"
  scope = "/subscriptions/e854f594-274f-4051-841b-78df7655d73c"
}
resource "azurerm_role_assignment" "cleanup" {
  scope              = azurerm_resource_group.runner.id
  role_definition_id = data.azurerm_role_definition.cleanup.id
  principal_id       = var.cleanup_principal_id
  principal_type     = "ServicePrincipal"
}
