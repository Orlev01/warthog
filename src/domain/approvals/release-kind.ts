// Which approvals are RELEASES (brief "High-tier release" / "Card requests"; design
// §4.2): a card or a high-tier identity detail is handed over once — the person's
// device decrypts it and posts it to the release endpoint, and the agent collects it
// with `collect_release`. Warthog never RUNS a release as a tool. Every other
// approval guards a routine held call that Warthog runs exactly once on approval.
//
// Pure domain module: the one discriminator the pipeline, check_approval and the inbox
// all read (the `request` field of a held call / approval detail), so they can never
// disagree about which approvals are run and which are collected.

/** The two kinds of one-time hand-over. */
export type ReleaseRequest = "card" | "high_tier";

/** Whether a held call's / approval detail's `request` names a release. */
export function isReleaseRequest(request: unknown): request is ReleaseRequest {
  return request === "card" || request === "high_tier";
}
