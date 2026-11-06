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
import { listIdentityFields } from "@/server/db/identity-fields";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Session } from "@/server/auth/session";
import type { Db } from "@/server/db/index";

// The dependency bundle: the database seam, plus the KeyWrapper that unwraps the
// person's DEK so the greeting can read their low-tier name (exactly as the vault
// page-data loader does). The key wrapper is optional — with none, the greeting
// falls back to the email's local part.
export interface HomeActionsDeps {
  readonly db: Db;
  readonly keyWrapper?: KeyWrapper;
}

// The home actions the thin loader drives: turn the verified session into the
// dashboard's props.
export interface HomeActions {
  load(session: Session): Promise<DashboardViewProps>;
}

export function createHomeActions(deps: HomeActionsDeps): HomeActions {
  const { db, keyWrapper } = deps;

  // Assemble the dashboard's props for the signed-in person: name them from their
  // OWN account (scoped by the session's user id, never a client value), show the
  // five set-up items all not done, and leave every data-bearing section empty so
  // each renders a plain message rather than a dead control.
  async function load(session: Session): Promise<DashboardViewProps> {
    const user = await getUserById(db, session.userId);
    // The email's local part is the fallback greeting when no name is saved (or no
    // key is available to decrypt one).
    const email = user?.email ?? session.userId;
    const localPart = email.split("@")[0] ?? email;

    // Greet by the person's own low-tier name when it is readable: preferred name
    // first, then name, else the email's local part. The fields decrypt only under
    // THIS person's DEK, so the greeting can never name another account.
    let personName = localPart;
    if (user && keyWrapper) {
      const dek = await keyWrapper.unwrap(user.wrappedDek);
      const fields = await listIdentityFields(db, user.id, dek);
      const preferred = fields.find((field) => field.kind === "preferred_name")?.value;
      const name = fields.find((field) => field.kind === "name")?.value;
      personName = preferred ?? name ?? localPart;
    }

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
