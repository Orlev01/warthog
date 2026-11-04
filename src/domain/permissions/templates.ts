// E03-S05 — Permission sets and templates (design §7; brief "Agent consent
// screen" + "Per-agent permissions page").
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// The consent screen and the per-agent permissions page build on these starting
// sets, so the templates live here as a pure function of (template name, the
// services the person ticked), built before its consumers.
//
// The vocabulary is exactly the brief's:
//   Minimal  — the low-tier profile, skills and preferences, and logging
//              activity; nothing else.
//   Standard — Minimal plus reading shared memory, saving its own memories (kept
//              to itself unless sharing is switched on), tasks and life-admin
//              records, and the read tools of the ticked services, with those
//              services' change-making tools set to "ask me first"; never
//              high-tier and never card.
//   Custom   — starts from Standard with every setting open to change.
//
// High-tier requests, card requests and sharing what it learns are ALWAYS opt-in
// (default off) in every template.

/** The three starting templates the consent screen offers. */
export type PermissionTemplate = "minimal" | "standard" | "custom";

/**
 * One ticked service's grant: its read tools are granted, and its change-making
 * tools default to "ask me first" (`ask_first` — the same vocabulary as the
 * rules module's `RuleKind` and the policy engine's "ask me first").
 */
export interface ServicePermission {
  service: string;
  readTools: boolean;
  changeTools: "ask_first";
}

/**
 * A starting permission set. Each capability flag is read-without-asking (or
 * off); the `services` list carries one grant per ticked service. High-tier,
 * card and learning-sharing are always opt-in, so every template starts them off.
 */
export interface PermissionSet {
  lowTierProfile: boolean;
  skills: boolean;
  preferences: boolean;
  activityLogging: boolean;
  sharedMemoryRead: boolean;
  ownMemorySave: boolean;
  tasks: boolean;
  lifeAdmin: boolean;
  services: ServicePermission[];
  highTier: boolean;
  card: boolean;
  learningSharing: boolean;
}

/**
 * One read grant per ticked service, with change-making tools defaulting to
 * "ask me first". A fresh array (and fresh grant objects) every call.
 */
function grantServices(services: readonly string[]): ServicePermission[] {
  return services.map((service): ServicePermission => ({
    service,
    readTools: true,
    changeTools: "ask_first",
  }));
}

/**
 * Build the starting permission set for a template and the ids of the services
 * the person ticked. Minimal ignores the ticked services (it grants nothing
 * beyond the base four); Standard and Custom add the standard capabilities and
 * the ticked-service read grants. Each call returns a fresh, independently
 * editable set (Custom is "fully editable").
 */
export function permissionTemplate(
  template: PermissionTemplate,
  services: readonly string[] = [],
): PermissionSet {
  // Standard and Custom add shared-memory read, own-memory save, tasks,
  // life-admin and the ticked-service grants; Minimal grants only the base four.
  const grantsStandard = template === "standard" || template === "custom";
  return {
    // The base four — granted in every template.
    lowTierProfile: true,
    skills: true,
    preferences: true,
    activityLogging: true,
    // Standard's additions (not service-dependent).
    sharedMemoryRead: grantsStandard,
    ownMemorySave: grantsStandard,
    tasks: grantsStandard,
    lifeAdmin: grantsStandard,
    // Ticked-service grants: read tools on, changes ask-me-first.
    services: grantsStandard ? grantServices(services) : [],
    // Always opt-in — off in every template.
    highTier: false,
    card: false,
    learningSharing: false,
  };
}
