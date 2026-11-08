-- 0050_held_request_outcome — keep the outcome of a held call (design §6.2, brief
-- "Agents wait safely": "when approved, Warthog itself carries out the held request
-- exactly as it was approved and returns the result to the agent").
--
-- The inbox runs an approved held call the moment the person approves it, while the
-- agent learns the outcome later through `check_approval`. So the outcome has to
-- outlive the run: `outcome` holds it — `{status:"executed", result}` or
-- `{status:"refused", reason}` — stored only DEK-ENCRYPTED (a `v1:` envelope bound to
-- this table/column/row, design §4.1), because a tool result is personal content.
-- NULL until the claimed call has finished running.
--
-- Additive and safe on existing rows: a nullable column with no default.

ALTER TABLE held_requests ADD COLUMN outcome text;
