# Delivery permissions

The founder authorized completing foundation permissions, production secrets and
private-runner setup on 10 November 2026. This module owns the production resource
group and application identity as security anchors; the foundation reads them.
It grants no subscription Owner role and does not modify DNS or create an app.

The plan identity reads the production group. Apply gets explicit resource writes
there, no deletes or user-assigned-identity/federation writes. A separate condition
allows it to grant only four reviewed application data roles, and only to the
fixed application identity. Budget permissions apply only to the existing named
budget. Both identities get subscription/provider/role-definition metadata reads.
State-container grants remain in `infra/bootstrap`; the personal operator has
additional data access only to the state container for authorized setup.

The release identity can manage apps/revisions and group deployments, and assign
only the dedicated app identity. It has no Key Vault secret-value permission,
public DNS writes or foundation resource writes. Registry push/pull grants are
added only after the dedicated registry exists (`registry_ready=true`).

The cleanup identity is distinct from every delivery identity. It can enumerate
resource-group metadata, detach the runner subnet's NAT, and delete only lease
groups where `infra/runner` explicitly grants it that right. It cannot provision
resources, read application secrets or delete the production/delivery groups.
Its main-only GitHub environment intentionally needs no review for cleanup;
the original four delivery environments retain their founder review gates.

The founder has Secrets Officer and Crypto Officer on the dedicated vault after
`private_network_ready=true`, still subject to its subnet firewall. These grants
support initial setup and rotation; no pipeline receives them. Control-plane
foundation access is privileged configuration access, not a guarantee against a
malicious approved infrastructure change. Review actual plans and workflow source.

Run with owner-only local state and the verified personal Warthog account. Inputs
are `access_approved=true`, the verified personal `operator_principal_id`, and the
two readiness flags matching existing resources. Never reset a readiness flag to
false casually: that plans removal of established grants. Do not replace the
existing state or recreate this module. Preserve private evidence in `.delivery/`.

Azure's [delegation conditions](https://learn.microsoft.com/en-us/azure/role-based-access-control/delegate-role-assignments-examples)
constrain both allowed role definitions and recipient identity. Current access
has been checked through Terraform and independent ARM reads; GitHub environment
OIDC exercises remain separate from static trust/permission validation.
