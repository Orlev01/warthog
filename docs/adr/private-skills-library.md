# Private skills and plugin library

Status: local implementation, 10 November 2026. Requested by the founder; no deployment implied.

## Investigation and scope

Grove (`/Users/oren.levy/Dev/grove`, 80a7996) provides searchable skill/toolkit cards,
folder and `.skill` import, frontmatter parsing, file previews and editing, plugin
composition, and export/install guidance. Its GitHub publishing, departments,
authors, review/sign-off and marketplace rankings serve an organisation. Warthog
serves one person's agents and keeps their content encrypted in PostgreSQL.

Warthog at da5301c already has encrypted skill CRUD, preferences, agent scope,
an enabled switch, context indexing and lazy `get_skill` reads. Its Skills page
puts the long preferences form first, has no import/search/file support, and
offers a chosen-agent option without an agent picker.

Bring across import-first discovery, searchable cards, plugin grouping, previews,
file editing and portable downloads. Keep Warthog's zinc/indigo tokens, shell,
preferences, permissions and house skill. No public sharing, GitHub writes,
marketplace/review vocabulary, model calls or automatic plugin execution.

## Storage and behaviour

Store each imported/created package as a per-owner encrypted document, plus
relational membership in existing skills. The package's files are the source of
truth; skill rows are an atomic projection for the existing agent context and
permission model. Updates preserve matched skill IDs and their permissions;
new skills start switched off. Revision checks prevent stale edits overwriting
another tab. A package delete also removes its skill projections.

Support UTF-8 Markdown, skill/plugin folders and stored/deflated ZIP (`.zip`,
`.skill`, `.plugin`) archives. Bound upload bytes, expanded bytes, per-file size,
file count and paths before persistence. Reject corrupt/unsafe archives. Report
ignored system files and binary attachments. Preserve source frontmatter and
supporting file paths. Native Node zlib handles bounded inflation; no dependency
or service is added. Download uses a standard stored ZIP.

Only SKILL.md instructions are exposed as skills; supporting files beneath that
skill's folder are readable through the same enabled/scope check. Hooks, scripts,
agents, commands and MCP configuration remain inert files for editing/download.
An import never changes connector credentials or grants agent access. Packages
also participate in account export/import and cascade on account deletion.

## Work and evidence

- [x] Parser/archive limits and round-trip tests.
- [x] Encrypted transactional persistence, owner isolation, revisions and agent reads.
- [x] Import preview, creation, editing, deletion, download and named agent picker.
- [x] Searchable responsive library and preferences disclosure.
- [x] Full test suite, typecheck, build and browser acceptance.

## Grove comparison and Warthog adaptation

| Grove capability | Warthog result |
| --- | --- |
| Marketplace skill and toolkit cards | Private Skills & plugins library with type/availability filters and search over names, descriptions and contained skill names |
| Browser folder drop and `.skill` import | Folder drop/picker, Markdown files, `.skill`, `.plugin` and `.zip`; bounded server validation and preview before persistence |
| Toolkit detection and composition | Explicit manifest or component layout stays a plugin, even with one skill; command-only plugins can be retained as files |
| Skill frontmatter and supporting files | Exact imported source retained; form edits preserve unknown frontmatter; supporting text files keep their relative paths |
| Skill/toolkit editing | Name/description/instructions form, source editor, file addition/removal, complete package duplication and confirmed deletion |
| GitHub tree commits | Per-owner encrypted package/summary documents in PostgreSQL and owner-bound skill membership rows |
| GitHub conflict/retry handling | Owner-serialised transactions plus revision checks; stale edits fail without overwriting current files |
| Skill installation/export guides | Downloadable standard ZIP, legacy Markdown downloads, account export/import and native Warthog agent availability controls |
| Lightweight catalogue listing | Encrypted summary projection; file contents fetched only after opening a package |
| Departments, authors, tags, ratings, upkeep and sign-off | Omitted: organisation/marketplace concepts do not describe this single-user library |
| GitHub publishing and external-plugin links | Omitted: no content leaves Warthog to a repository and no external fetch/installation is triggered |
| Hooks, commands, scripts, agent and MCP files | Retained for editing/export, with an explicit explanation that Warthog does not execute or activate them |

Key Grove references (relative to its repository):

- `src/app/marketplace/` and `src/components/skill-card.tsx` /
  `toolkit-card.tsx`: catalogue browsing and grouped cards.
- `src/components/skill-drop-zone.tsx`, `src/lib/skill-bundle.ts`,
  `parse-skill-md.ts`, `supporting-files.ts` and `skill-validation.ts`: import,
  bundle detection, metadata and supporting-file boundaries.
- `src/components/edit-skill-form.tsx`, `edit-toolkit-form.tsx`,
  `submit-skill-form.tsx` and `skill-export-guide.tsx`: composition, editing,
  preview, submission and portability.

Warthog's skills domain/store, page/actions, preferences, agent permissions, MCP
retrieval, envelope encryption, migrations, role grants, account export/import
and account purge paths informed the implementation.

## Implementation details

- Migration `0100_skill_packages.sql` adds `skill_packages` and
  `skill_package_members`. The files, names, descriptions, path-to-skill mapping and
  summary are encrypted with the existing per-person data key and row/column-bound
  envelopes. Composite foreign keys prevent cross-owner memberships.
- Package files are canonical. Matching source paths retain skill IDs, enabled
  state and scope on edit; new paths create disabled skills. Missing paths remove
  projections in the same transaction. Legacy content mutation endpoints refuse
  packaged skills so an old request cannot desynchronise the package.
- `get_skill` accepts an optional `file` path. Its existing enabled/scope check
  runs before returning either instructions or supporting files. It exposes files
  beneath that skill's folder, not another plugin skill's folder or all plugin
  configuration. Nested skills keep independent file boundaries, including when
  a plugin has a root SKILL.md. Traversal paths are refused. The ordinary no-file call includes
  available supporting paths, without eagerly sending every file.
- Account format version 1 gains an optional `skillPackages` section. Plain text
  skill entries remain for older readers; `packageId` links let this importer
  rebuild full packages without duplicate instruction rows. Imports generate new
  IDs and leave package skills off for a fresh review of agent access.
- The library uses a wider, capped two-column layout because cards are compared
  side by side. Forms stay readable; phones reflow to one column with paired
  filters and scrollable dialogs. Existing tokens, shell and house skill remain.

## Deliberate limits

Import one package at a time. Up to 100 UTF-8 text files, 200 KB per file and 1 MB
expanded content; archive upload cap is 5 MB and at most 200 ZIP entries including
directories. ZIP32 stored and deflate formats are supported. Encrypted archives,
ZIP64, symlinks, unsafe/duplicate paths, corrupt checksums and oversized expansion
are rejected. System directories are excluded; omitted binary files are listed
in the preview. Binary assets are not retained. Frontmatter display fields support
plain/quoted and folded/literal scalars, while unrecognised source metadata is
preserved. This is not a general YAML editor or a plugin execution environment.

## Concurrent agent-first branch

At review time `codex/warthog-agent-first` was independently changing
`src/server/db/skills.ts`, `src/server/export/build.ts`,
`src/server/export/schema.ts` and `src/server/import/import.ts`. Its migration is
`0101_agent_controls.sql`, so migration names do not collide. Neither checkout
has been modified or merged by this work.

Before combining the branches:

1. Retain the agent-first `agent_skill_access` checks in both skill indexing and
   retrieval, and keep package file reads after that effective access check.
2. Reconcile the library's scope picker with those explicit per-agent overrides.
   The library must display effective access and a saved selection must not leave
   a previously allowed override active after that agent is deselected. Test
   changes in both directions across the library and agent settings screens.
3. Preserve both additive export sections and the agent-first legacy-skill import
   rules. Keep package deduplication and disabled package imports from this branch.
4. Run both feature suites after integration. This branch is verified against
   deployed design base `da5301c`; integration with the unfinished parallel feature
   is not claimed.

## Validation

- Full regression: 5,122 tests passed, including production build, bootstrap and
  unauthenticated-route guards. After final refinements, 33 focused library checks
  and 153 related skills, MCP, export/import and action checks passed. The final
  regression specifically proves a parent skill cannot retrieve or list nested
  skill files or root plugin configuration. Typecheck and production build passed.
- Runtime staging passed with all 71 migrations and 106 connector definitions.
  Dependencies were installed locally from the unchanged lockfile so the isolated
  worktree's standalone output has no links into another checkout.
- Browser: 37 checks passed with no console/page errors. Covered light/dark
  library layouts at 320/360/390/768/1023/1024/1440/1920px, package dialogs,
  search/filter reset, edits/reload, named-agent selection, Markdown/folder/ZIP
  import, duplicate conflict, download, create, file addition, duplication,
  two-tab stale-edit refusal, delete/cancel, DataTransfer drop, Escape/unsaved
  confirmation and reaching the mobile dialog footer.
- Real PostgreSQL 16: all 71 migrations and repeat migration pass; runtime-role
  writes, owner isolation, concurrent revision contention, scoped file retrieval,
  package export/import and cascade purge passed. Used synthetic data on an
  isolated internal Docker network with tmpfs storage; container/network removed.
- Local browser scripts, screenshots and detailed results are under ignored
  `.delivery/skills-library/`. Logs use `/tmp/warthog-skills-*`. No production
  database, provider credentials, deployment or external content publication was
  used for these checks.

## Agent-first integration (11 November 2026)

Integrated with the agent controls branch. Library audiences display effective
per-agent access, including workspace overrides. Saving a library audience
replaces those overrides under the same skill-row lock used by workspace edits.
Source disable remains authoritative for both instructions and supporting files.
Export/import retains both agent settings and encrypted package content; imported
packages start disabled and require assignment. The 60 focused skills tests and
TypeScript checks pass on the combined tree.

## Amendment, 25 November 2026 (founder)

Warthog's own skills are no longer separate from the library. They appear on the Skills page, and
the person can edit, switch off, remove, scope and restore them, with fixed rules and generated parts
kept out of reach. Their titles are reserved: a person's skill or an imported package can't take
one. See docs/adr/editable-builtin-skills.md.
