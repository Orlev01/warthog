# Memory and skill collection bounds

11 November 2026. Agent context and resource permission pages use keyset pages
ordered by creation time and ID. Cursors preserve PostgreSQL microseconds, so
records created within the same millisecond are not skipped. Visibility is checked
in SQL before decryption. Permission saves change only submitted records; paging
never revokes assignments on another page. Workspace skill counts cover the full
granted collection rather than just the visible page.

`get_context` returns up to 50 skills and memories by default (100 on request),
plus the house skill. Its `next.memory` and `next.skills` cursors become
`memory_cursor` and `skill_cursor` on the next request. Stored skills expose an ID
for direct `get_skill` lookup, which still checks ownership, enabled state and
agent audience. Title-only lookup is bounded to 1,000 candidates.

`search_memory` scans up to 100 visible records by default (maximum 200), returning
`scanned` and `nextCursor`. Text stays encrypted in storage and is matched only
within the permitted decrypted page. Callers must follow the cursor even when a
page has no matches. The portal offers older/first-page navigation and describes
this search behavior. Ordinary portal pages and agent selectors show 50 records.

All memory, standalone-skill and package writes take the owner row lock in the
write transaction. This serializes concurrent imports and agent writes against
account limits: 5,000 memories / 20 MB encrypted storage; 1,000 skills / 30 MB;
100 packages / 30 MB. Package projections count toward the skill limit as well.
Limits measure stored envelopes, including encryption overhead, not plaintext.
Updates subtract the previous envelope size; shrinking an over-limit collection
is allowed. A rejected package or account import rolls back atomically.

The global library retains its quota-bounded metadata index and standalone edit
bodies, displaying 24 items at a time with search across the whole index; package
supporting files load on demand. Package title checks avoid
loading existing instruction bodies. Existing data is never truncated or deleted
to satisfy a new quota. Full account exports remain complete rather than being
silently limited to the first page.

Regression coverage includes concurrent quota attempts, replacement sizes,
microsecond timestamps, same-time IDs, foreign-account exclusion, per-agent
visibility, direct skill retrieval, and preserving assignments on other pages.
