// Existing account default; shared by display formatting and personal budgets.
// Household month calculations explicitly use UTC and do not consult this default.
export const DEFAULT_TIME_ZONE = "Australia/Sydney";

export function accountTimeZone(saved: string | null | undefined): string {
  const value = saved?.trim() ?? "";
  if (value) {
    try {
      new Intl.DateTimeFormat("en-AU", { timeZone: value });
      return value;
    } catch { /* Invalid saved free text uses the established account fallback. */ }
  }
  return DEFAULT_TIME_ZONE;
}
