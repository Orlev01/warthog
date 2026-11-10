variable "subscription_id" {
  type = string
  validation {
    condition     = var.subscription_id == "e854f594-274f-4051-841b-78df7655d73c"
    error_message = "Bootstrap targets only the dedicated personal Warthog subscription."
  }
}

variable "tenant_id" {
  type = string
  validation {
    condition     = var.tenant_id == "72277873-e056-4612-9b1c-7ad58e02fcf3"
    error_message = "Use the personal Warthog tenant, never an Eucalyptus identity."
  }
}

variable "bootstrap_approved" {
  type        = bool
  default     = false
  description = "Attestation of founder approval of these exact resources, public HTTPS networking, OIDC trust and permissions; this variable is not approval."
  validation {
    condition     = var.bootstrap_approved
    error_message = "State storage and federated identity creation need their exact approval before plan/apply."
  }
}
