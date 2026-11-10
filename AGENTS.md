# Warthog contributor guidance

Warthog is the Next.js personal agent home described in [brief.yaml](brief.yaml).
Read [CLAUDE.md](CLAUDE.md) and the relevant sections of the
[technical design](docs/design/technical-design.md) before changing behavior.
Preserve the existing visual identity; UI work should improve the affected flow.

For UI changes, use [warthog-design-system](.agents/skills/warthog-design-system/SKILL.md)
and only the focused skills relevant to the change:

- [Mobile design](.agents/skills/warthog-mobile-design/SKILL.md): narrow layouts, touch, safe areas and mobile navigation.
- [Desktop design](.agents/skills/warthog-desktop-design/SKILL.md): content widths, desktop composition and keyboard use.
- [Feedback](.agents/skills/warthog-feedback/SKILL.md): icons, help, notices, copy feedback and toasts.
- [Media](.agents/skills/warthog-media/SKILL.md): QR codes, files, long values and other media or data displays.

These are contributor skills, separate from the application's user-authored Skills feature.
Use the current checkout explicitly when other agents are working in another worktree.

## Agent-first product model

Read [the agent-first decision](docs/adr/agent-first-management.md) when changing
resources, permissions, navigation, onboarding or agent tools. Agents are the
primary management unit. Account-owned resource inventory is separate from an
agent's effective access. Global defaults seed new connections; global rules
remain enforced for every agent. Keep displayed permissions, context discovery,
direct retrieval, execution and audit evidence consistent. Never imply that a
service connector registers that provider's agents, or that Warthog controls
activity outside its own connection.
