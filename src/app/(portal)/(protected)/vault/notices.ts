import type { NoticeTone } from "@/components/ui/notice";
import { hrefWith } from "@/lib/href";

// About you's outcome notices for the plain-form actions (Add / Not mine on a suggestion) and
// where they return to. A plain module (not the page entry) so both can be tested without a
// request, as the Memory page's are.

export type AboutYouNotice = "suggestion_added" | "suggestion_declined" | "suggestion_gone" | "problem";

// What happened, in plain words; a problem says nothing changed and what to do next.
const NOTICES: Record<AboutYouNotice, { readonly tone: NoticeTone; readonly text: string }> = {
  suggestion_added: { tone: "success", text: "Added to About you." },
  suggestion_declined: { tone: "success", text: "Removed. It won't be suggested again." },
  suggestion_gone: { tone: "error", text: "That suggestion is no longer waiting, so nothing was changed." },
  problem: { tone: "error", text: "We couldn't make that change to About you. Please try again." },
};

export function aboutYouNotice(raw: string | string[] | undefined) {
  return typeof raw === "string" && Object.hasOwn(NOTICES, raw) ? NOTICES[raw as AboutYouNotice] : null;
}

// About you, with the notice naming the outcome. The path is fixed, so nothing a form sends
// can turn the return into another page.
export function aboutYouReturnUrl(notice: AboutYouNotice): string {
  return hrefWith("/vault", { notice });
}
