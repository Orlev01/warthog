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

export function recordReturnPath(form: FormData): string {
  const value = form.get("returnTab");
  const tab = typeof value === "string" && ["subscriptions", "receipts", "renewals", "checklist"].includes(value)
    ? value : "subscriptions";
  return `/life-admin?view=life&tab=${tab}`;
}

// Empty input disables reminders. Invalid nonempty entries survive as NaN so
// boundary validation refuses the whole change instead of silently losing it.
export function recordOffsets(raw: string): number[] {
  return raw.split(",").map(part => part.trim()).filter(Boolean).map(Number);
}
