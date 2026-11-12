# Workspace depth and grouping

12 November 2026: the founder requested more depth, texture, grouping and topology
inside the application. This builds on the neutral admin-console reference;
marketing and account-entry composition remain separate.

## Three visual levels

- **Canvas:** a quiet neutral workspace behind content. It separates the navigation,
  page chrome and the task at hand without changing width ownership.
- **Panel:** an opaque surface, fine edge, inner highlight and shallow shadow for
  one meaningful group. Use `WorkspacePanel` for a titled group with an icon and
  optional action, or `wh-surface` for bespoke composition. The shared `Card`
  receives the same depth only inside `AppShell`.
- **Inset:** muted surfaces for supporting facts and controls inside a panel. Do
  not give every field another raised card. Nested cards lose their extra shadow.

`src/app/workspace.css` scopes palette and depth to `.wh-workspace`. Its light and
dark values follow the existing explicit/system `color-scheme`; the public
palette is unchanged. Keep decorative textures away from long text and form
fields. A small static dot pattern is reserved for the access-map introduction.
No images, animation libraries, remote assets or new runtime dependencies are used.

## Organise by purpose

Use `WorkspaceHeading` for the page identity and one compact action group. Home
separates decisions and recent activity from agent connections, setup and reminders.
The activity rail connects events without implying that one caused another.
Setup progress comes from the real checklist; do not invent dashboard statistics.

Agent overviews group their existing destinations into **Resources** and
**Controls & history**. Branch lines indicate navigation relationships, not live
network traffic. Every link keeps the same agent ID. Grant summaries remain based
on actual permissions; connection evidence stays distinct from self-reported client
metadata and measured request outcomes. A connected credential is not a heartbeat.

Settings and permissions use the same surfaces, with a group boundary around a
coherent task rather than a border around every paragraph. Preserve native forms,
confirmation, pending states, audit semantics and draft retention.

## Responsive and accessible

One column is the default. Supporting columns appear only when there is room;
the desktop sidebar keeps its existing 1024px breakpoint. Surfaces shrink with
`min-width: 0`; long values wrap. Controls retain phone touch sizes and input text.
Do not clip focus to achieve rounded corners. Texture is noninteractive and
decorative; forced colours remove it and retain explicit borders. The only added
motion is a short hover/focus colour transition, disabled by reduced motion.

Check populated and empty Home, agent lists and overview, editable permissions,
resource lists and Settings in both themes. Include narrow phones, the sidebar
breakpoint, a wide monitor, safe areas, long content, keyboard navigation and
existing tab/drawer behaviour. Report browser evidence separately from tests.
