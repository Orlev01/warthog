# Adopt the admin console design structure

Decision: 11 November 2026, following the founder's explicit request to apply the
OpenAI admin console's visual language, grouping, tabs and sub-tabs to Warthog.
This supersedes the earlier indigo-accent and mobile-bottom-navigation choices
in the brief, technical design and contributor skills. It preserves the
[agent-first product model](agent-first-management.md), all capabilities and
member-scoped enforcement.

Use the [measured reference](../design/admin-console-reference.md) and existing
local primitives. Introduce shared route navigation and keyboard-accessible
in-page tabs, a 260px grouped desktop sidebar and a mobile modal drawer. Use a
neutral primary-action palette in both themes. Keep Warthog branding, locally
licensed Inter, Lucide, accessible touch sizes and readable form measures.

Cross-page links preserve existing routes and agent section parameters. New
in-page view parameters are validated against known keys, preserve unrelated
query parameters, restore on Back/Forward, and retain drafts in inactive panels.
Forms and grants still use their existing handlers. No new data model, library,
provider integration, production deployment or credential change is part of this
design decision.

Validate route reachability, nested agent scope, keyboard navigation and draft
retention; then inspect populated, empty and error views in both themes across
desktop, phone and short landscape widths. CSS measurement and browser evidence
are required for layout claims; markup tests alone do not establish reflow.
