-- 0068_agent_permissions_tasks_records — dedicated tasks and life-admin records grants
-- (review fix A2; brief "Agent consent screen": Standard includes "tasks and life-admin
-- records", Minimal does not).
--
-- Until now the tasks and records tools gated on `read_tools` / `change_tools`, which are
-- the CONNECTOR tool-class settings (design §7: a ticked service's read tools, its
-- change-making tools "ask me first"). The consent screen set those from the ticked
-- services only, so a Standard agent with no services ticked was refused list_tasks,
-- create_task, list_records and save_record, and the screen's "Your tasks" / "Your
-- life-admin records" toggles changed nothing. Each now has its own grant.
--
-- Additive and safe on existing data: both columns are NOT NULL with a false default,
-- then backfilled so no existing agent loses access it has today (`read_tools` or a
-- `change_tools` other than off — the old gate) and an agent consented to as Standard or
-- Custom gains what it was promised (`memory_read` is on exactly for those templates,
-- since the consent screen's shared-memory toggle was ignored until this fix). A Minimal
-- agent keeps neither.

ALTER TABLE agent_permissions
  ADD COLUMN tasks_access   boolean NOT NULL DEFAULT false,
  ADD COLUMN records_access boolean NOT NULL DEFAULT false;

UPDATE agent_permissions
   SET tasks_access   = (read_tools OR change_tools <> 'off' OR memory_read),
       records_access = (read_tools OR change_tools <> 'off' OR memory_read);
