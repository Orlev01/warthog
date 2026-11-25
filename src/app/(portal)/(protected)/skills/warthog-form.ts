// What the Skills page's Warthog-skill forms post (src/components/skills/warthog-skills.tsx),
// read for the `changeWarthogSkillAction` server action in `page.tsx`. Pure: no session, no DB.
// Every form carries the skill's `key` and the `change` it makes; the seam validates both
// (an unknown key, or a field too long or blank, is refused there before anything is written).
import { builtinByKey } from "@/domain/skills/builtins";
import type { WarthogSkillChangeInput } from "./actions";

type Change = WarthogSkillChangeInput["action"];

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

// The seam's input for a posted form, or null when the form names no change Warthog knows.
export function warthogSkillChange(form: FormData): WarthogSkillChangeInput | null {
  const key = text(form, "key");
  const change = text(form, "change");
  switch (change) {
    case "on":
    case "off":
    case "remove":
    case "restore":
    case "use_new":
    case "keep_mine":
      return { key, action: change };
    case "edit":
      return { key, action: "edit", useThisWhen: text(form, "useThisWhen"), guidance: text(form, "guidance") };
    case "scope": {
      // The agent boxes are always on the form (it works without JS); they count only with
      // Only these agents.
      if (text(form, "scope") !== "chosen") return { key, action: "scope", scope: "all" };
      const scopedAgentIds = form.getAll("scopedAgentIds").filter((id): id is string => typeof id === "string" && id.length > 0);
      return { key, action: "scope", scope: "chosen", scopedAgentIds };
    }
    default:
      return null;
  }
}

// The page's notice for each change (the texts are in page.tsx's NOTICES).
export type WarthogNotice =
  | "warthog_on"
  | "warthog_off"
  | "warthog_removed"
  | "warthog_restored"
  | "warthog_new"
  | "warthog_kept"
  | "warthog_scope"
  | "updated";

const NOTICE_FOR: Record<Change, WarthogNotice> = {
  on: "warthog_on",
  off: "warthog_off",
  remove: "warthog_removed",
  restore: "warthog_restored",
  use_new: "warthog_new",
  keep_mine: "warthog_kept",
  scope: "warthog_scope",
  edit: "updated",
};

export function warthogNotice(change: Change): WarthogNotice {
  return NOTICE_FOR[change];
}

// After a change the page comes back with that skill's card open (`?skill=`), for Warthog's
// own keys only.
export function warthogReturn(key: string): string {
  return builtinByKey(key) ? `&skill=${encodeURIComponent(key)}` : "";
}
