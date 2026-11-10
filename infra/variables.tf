variable "subscription_id" {
  type = string
  validation {
    condition     = var.subscription_id == "e854f594-274f-4051-841b-78df7655d73c"
    error_message = "This foundation targets only the dedicated Warthog subscription."
  }
}

variable "tenant_id" {
  type = string
  validation {
    condition     = var.tenant_id == "72277873-e056-4612-9b1c-7ad58e02fcf3"
    error_message = "Use the approved personal Warthog tenant."
  }
}

variable "provisioning_approved" {
  type        = bool
  default     = false
  description = "Set true only after the founder approves the exact resource plan, quote and funding protection. This flag is not approval."
  validation {
    condition     = var.provisioning_approved
    error_message = "Paid provisioning, credentials and funding protection require separate approval."
  }
}

variable "names" {
  type = object({
    resource_group        = string
    virtual_network       = string
    postgres              = string
    postgres_private_dns  = string
    registry              = string
    key_vault             = string
    storage_account       = string
    receipt_container     = string
    identity              = string
    logs                  = string
    container_environment = string
  })
  description = "Reviewed globally unique resource names; no existing shared resources are implicitly reused."
}

variable "network" {
  type = object({
    address_space    = list(string)
    app_subnet       = string
    postgres_subnet  = string
    bootstrap_subnet = string
  })
  description = "Reviewed nonoverlapping CIDRs. App workload-profile subnet must be /27 or larger; private bootstrap has no public IP by default."
}

variable "postgres" {
  type = object({
    sku                   = string
    storage_mb            = number
    storage_tier          = optional(string)
    backup_retention_days = number
    zone                  = string
    administrator_login   = string
    password_version      = number
  })
  validation {
    condition     = startswith(var.postgres.sku, "GP_") && var.postgres.backup_retention_days >= 7 && var.postgres.backup_retention_days <= 35
    error_message = "Production requires an approved General Purpose SKU and 7–35 day backup retention."
  }
  description = "Premium SSD v1 only; select an explicit performance tier in the launch profile. Higher storage/performance needs a new cost review; disk shrink is destructive."
}

variable "postgres_admin_password" {
  type        = string
  sensitive   = true
  ephemeral   = true
  description = "Privately supplied only at an approved plan/apply; write-only provider argument excludes this value from state and saved plans. Never put it in tfvars."
}

variable "log_daily_cap_gb" {
  type = number
  validation {
    condition     = var.log_daily_cap_gb > 0
    error_message = "Specify the reviewed positive log ingestion allowance; a log cap is not a spending cap."
  }
}

variable "monthly_azure_budget_aud" {
  type        = number
  description = "Estimated gross Azure usage before credits/tax, used for notifications only. Not a cash cap. Recalculate with infra/costs/estimate.py when sizing changes."
  validation {
    condition     = var.monthly_azure_budget_aud > 0
    error_message = "Supply the separately approved AUD notification budget, not a historical proposed envelope."
  }
}

variable "import_existing_budget" {
  type        = bool
  default     = false
  description = "Adopt the existing same-name subscription alert in the reviewed plan instead of attempting duplicate creation."
}

variable "budget_end_date" {
  type        = string
  default     = null
  description = "Match the existing budget expiry when importing, to avoid silently extending its lifetime."
}

variable "budget_start_date" {
  type        = string
  description = "Approved budget start, first day of its month, in YYYY-MM-DDT00:00:00Z form."
}

variable "alert_emails" {
  type        = list(string)
  description = "Approved operational budget notification recipients."
  validation {
    condition     = length(var.alert_emails) > 0
    error_message = "Approve at least one operational budget recipient."
  }
}
