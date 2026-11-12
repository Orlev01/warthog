// The one sentence every sign-in request screen repeats (follow-up S3). A plain module, not a
// client component, so both the server-rendered list and the client Approve dialog can read
// the value (a constant exported from a "use client" module reaches a server component only
// as a client reference, never as its text).
export const APPROVE_WARNING = "Only approve if you just tried to sign in on that device yourself.";
