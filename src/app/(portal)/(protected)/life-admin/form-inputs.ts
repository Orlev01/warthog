// Keep editable personal fields separate from scheduling metadata and React's
// server-action control fields, including when a personal field has the same name.
export function recordFields(form: FormData): Record<string, string> {
  const namespaced = form.get("recordFormVersion") === "2";
  return Object.fromEntries([...form.entries()]
    .filter(([name, value]) => typeof value === "string" && (namespaced
      ? name.startsWith("field:")
      : name !== "recordId" && name !== "setting" && !name.startsWith("$ACTION_")))
    .map(([name, value]) => [namespaced ? name.slice(6) : name, value as string]));
}

export function recordDate(form: FormData): string | null | undefined {
  // A form left open before the upgrade has only personal fields. In particular,
  // a legacy personal field named dueDate must not become scheduling metadata.
  if (form.get("recordFormVersion") !== "2") return undefined;
  const value = form.get("dueDate");
  return typeof value === "string" ? value || null : undefined;
}

export function recordStatus(form: FormData): string | undefined {
  if (form.get("recordFormVersion") !== "2") return undefined;
  const value = form.get("status");
  return typeof value === "string" ? value || undefined : undefined;
}

// The records view's tab (`?tab=`): the moving checklist, or "Your things". The tabs Life
// admin had before typed records (subscriptions, receipts, renewals) — still named in
// reminder links people already have — and anything else open "Your things".
export type RecordTab = "things" | "checklist";
export function recordTab(value: unknown): RecordTab {
  return value === "checklist" ? "checklist" : "things";
}

export function recordReturnPath(form: FormData): string {
  return `/life-admin?view=life&tab=${recordTab(form.get("returnTab"))}`;
}

// The record type the Add form posts ("vehicle.registration"); the action validates it.
export function recordTypeId(form: FormData): string {
  const value = form.get("type");
  return typeof value === "string" ? value : "";
}

// The vehicle, home or pet a record belongs to: undefined when the form has no "Belongs to"
// choice (the link is kept), null for "Not linked", else the chosen record's id (the action
// validates it as one of the person's own).
export function recordParent(form: FormData): string | null | undefined {
  const value = form.get("parentId");
  if (typeof value !== "string") return undefined;
  return value === "" ? null : value;
}

// Every record id a form posts (Confirm all posts one per suggestion).
export function recordIds(form: FormData): string[] {
  return form.getAll("recordId").filter((value): value is string => typeof value === "string");
}

// The field a refusal names, as carried back in the address (`&field=`): a short plain
// label only (letters, digits, spaces and simple punctuation), else nothing.
export function noticeField(value: unknown): string | null {
  return typeof value === "string" && /^[\p{L}\p{N} ,.'()&/+-]{1,60}$/u.test(value) ? value : null;
}

// Where a task action lands afterwards: the Tasks view, keeping the `?assignee=` filter
// the form was submitted under when it is well formed ("any" or a uuid). The page then
// validates it against the person's own agents, exactly as for a typed-in link.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function taskReturnPath(form: FormData): string {
  const value = form.get("returnAssignee");
  const assignee = typeof value === "string" && (value === "any" || UUID_RE.test(value)) ? value : null;
  return assignee ? `/life-admin?view=tasks&assignee=${assignee}` : "/life-admin?view=tasks";
}

// Empty input disables reminders. Invalid nonempty entries survive as NaN so
// boundary validation refuses the whole change instead of silently losing it.
export function recordOffsets(raw: string): number[] {
  return raw.split(",").map(part => part.trim()).filter(Boolean).map(Number);
}
