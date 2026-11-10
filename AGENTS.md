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
