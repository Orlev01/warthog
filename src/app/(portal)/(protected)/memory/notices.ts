import type { NoticeTone } from "@/components/ui/notice";
import { hrefWith } from "@/lib/href";

// The Memory page's outcome notices and where an action returns to. A plain module (not the
// page entry) so both can be tested without a request.

export type MemoryNotice =
  | "added"
  | "updated"
  | "rescoped"
  | "deleted"
  | "blank"
  | "problem"
  | "storage_full";

// What happened, in plain words; a problem names what failed and what to do next.
const NOTICES: Record<MemoryNotice, { readonly tone: NoticeTone; readonly text: string }> = {
  added: { tone: "success", text: "Memory added." },
  updated: { tone: "success", text: "Memory updated." },
  rescoped: { tone: "success", text: "Sharing updated." },
  deleted: { tone: "success", text: "Memory deleted." },
  blank: { tone: "error", text: "Type what to remember. A memory can't be blank, so nothing was saved." },
  problem: { tone: "error", text: "We couldn't save that change to your memory. Please try again." },
  storage_full: {
    tone: "error",
    text: "Storage limit reached. Remove unused items or reduce their size before saving.",
  },
};

export function memoryNotice(raw: string | string[] | undefined) {
  return typeof raw === "string" && Object.hasOwn(NOTICES, raw) ? NOTICES[raw as MemoryNotice] : null;
}

// Where a Memory action brings the person back to, with its notice: the same search,
// sharing and saved-by filters and the same page (interaction-14), so editing, re-sharing
// or deleting doesn't throw them back to the unfiltered list. Untrusted: only the known
// sharing values and bounded strings are kept, and the path is always /memory (hrefWith
// never emits another origin); the loader validates the source and cursor again.
const SCOPES = new Set(["kept", "shared"]);
export function memoryReturnUrl(formData: FormData, notice: MemoryNotice): string {
  const field = (name: string) => {
    const raw = formData.get(name);
    return typeof raw === "string" ? raw : "";
  };
  const scope = field("return_scope");
  return hrefWith("/memory", {
    q: field("return_q").slice(0, 200),
    scope: SCOPES.has(scope) ? scope : undefined,
    source: field("return_source").slice(0, 64),
    cursor: field("return_cursor").slice(0, 512),
    notice,
  });
}
