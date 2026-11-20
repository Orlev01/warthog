import type { NoticeTone } from "@/components/ui/notice";
import { CONTACT_DAILY_LIMIT, CONTACT_MESSAGE_MAX } from "@/domain/contact/topics";

// The outcome of sending a "Contact us" message, in plain words (the page maps `?notice=`).
type ContactNotice = { readonly tone: NoticeTone; readonly text: string };

const notices: Record<string, ContactNotice> = {
  sent: { tone: "success", text: "Message sent. We'll reply to you by email." },
  empty: { tone: "error", text: "Write your message, then send it." },
  "too-long": { tone: "error", text: `That's longer than ${CONTACT_MESSAGE_MAX.toLocaleString("en-AU")} characters. Shorten it, then send it again.` },
  topic: { tone: "error", text: "Choose what your message is about, then send it." },
  "too-many": { tone: "info", text: `You've sent us ${CONTACT_DAILY_LIMIT} messages today. We'll reply to those first, and you can send another tomorrow.` },
  problem: { tone: "error", text: "We couldn't send that just now. Please try again." },
};

export function contactNotice(raw: string | string[] | undefined): ContactNotice | null {
  return typeof raw === "string" && Object.hasOwn(notices, raw) ? notices[raw]! : null;
}
