// E18-S13 — Early home page loader (the injectable seam the thin `page.tsx`
// loader composes).
//
// Sign-up and sign-in land on `/home`, so the route mounts the home dashboard
// (<DashboardView>, E18-S07) behind a MINIMAL loader until the full data-driven
// loader (E18-S08) extends it: it names the signed-in person, shows the five
// first-run set-up items all NOT done (computeSetupChecklist({}) — the one source
// of the labels/links, this task hard-codes none), and leaves every data-bearing
// section in its empty state.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry
// file may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The thin loader reads the
// session + database and renders the view; the testable logic lives here (the
// convention's `createXHandler({ db })` pattern, here `createHomeActions`, exactly
// as the sibling security page uses `createSecurityActions`).
//
// Security (design §5): `load` takes the person's VERIFIED Session and derives the
// acting user id from `session.userId` — never a client-supplied value — so the
// greeting names the session's OWN person. The one read is parameterized (INV-102).

import { computeSetupChecklist } from "@/domain/home/checklist";
import type { DashboardViewProps } from "@/components/home/dashboard-view";
import { getUserById } from "@/server/db/users";
import type { Session } from "@/server/auth/session";
import type { Db } from "@/server/db/index";

// The dependency bundle: just the database seam this early — the full loader adds
// the feature-data reads (approvals, activity, agents, reminders) in E18-S08.
export interface HomeActionsDeps {
  readonly db: Db;
}

// The home actions the thin loader drives: turn the verified session into the
// dashboard's props.
export interface HomeActions {
  load(session: Session): Promise<DashboardViewProps>;
}

export function createHomeActions(deps: HomeActionsDeps): HomeActions {
  const { db } = deps;

  // Assemble the dashboard's props for the signed-in person: name them from their
  // OWN account (scoped by the session's user id, never a client value), show the
  // five set-up items all not done, and leave every data-bearing section empty so
  // each renders a plain message rather than a dead control.
  async function load(session: Session): Promise<DashboardViewProps> {
    const user = await getUserById(db, session.userId);
    // The only plaintext identity an account has this early is its email, so the
    // greeting is drawn from its local part (the real low-tier name arrives with
    // E18-S08).
    const email = user?.email ?? session.userId;
    const personName = email.split("@")[0] ?? email;

    return {
      personName,
      checklist: computeSetupChecklist({}),
      pendingApprovals: 0,
      activity: [],
      agents: [],
      reminders: [],
    };
  }

  return { load };
}
