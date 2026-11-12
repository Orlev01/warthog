// The words Warthog uses for an empty inbox, shared by Home's Inbox panel and the Inbox
// page so the one state reads the same everywhere (UI/UX pass content-40). Pure copy: no
// React, no I/O.

export const NOTHING_WAITING = {
  heading: "Nothing waiting for you",
  description: "When an agent asks to do something that needs your approval, you'll see it here.",
} as const;
