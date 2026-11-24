import * as React from "react";
import { CONNECTION_PRESETS } from "@/domain/permissions/connection-choices";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getServerDb } from "@/server/db/server";
import { withTransaction } from "@/server/db/index";
import {
  getAgentDefaults,
  saveAgentDefaults,
  agentDefaultsSchema,
} from "@/server/db/agent-defaults";
import { getUserById } from "@/server/db/users";
import { verifySession } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { loadConfig } from "@/server/config";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { createRedactingRecorder } from "@/server/mcp/recorder";
import { getReadLevel } from "@/server/db/read-settings";
import { createReadLevelActions, readLevelInputFromForm, readLevelNotice, readLevelNoticeCode } from "./actions";
import { ReadLevelChoices } from "@/components/settings/read-level-choices";
import { ArrowRight, ChevronDown } from "lucide-react";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Field, SelectField } from "@/components/ui/field";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { PageNotice } from "@/components/ui/notice";

// Settings › Agent defaults: the starting permissions for agents connected from now on, what
// every agent sees in the person's email and files (docs/adr/read-side-protection.md, amendment
// 24 November 2026), and the way to the controls that apply to every agent. The same
// composition as the other Settings tabs (containment-34): the heading band, the outcome
// notice, then one panel per task with its action in the panel footer. Every text block sits
// in a bounded surface (founder rule 1); the request limit is an advanced setting, out of the way.
export const metadata = { title: "Agent defaults" };
async function signedIn() {
  const token = (await cookies()).get("__Host-wh_session")?.value;
  const db = await getServerDb();
  const session = token
    ? await verifySession(db, token, { clock: systemClock })
    : null;
  if (!session) redirect("/signin");
  return { db, session };
}
async function save(form: FormData) {
  "use server";
  const { db, session } = await signedIn();
  const parsed = agentDefaultsSchema.safeParse({
    template: form.get("template"),
    rateLimit: Number(form.get("rateLimit")),
  });
  if (!parsed.success) redirect("/settings/agents?notice=invalid");
  const config = loadConfig();
  const user = await getUserById(db, session.userId);
  if (!user) redirect("/signin");
  const dek = await selectKeyWrapper({
    nodeEnv: config.nodeEnv,
    localKek: config.devKek,
  }).unwrap(user.wrappedDek);
  await withTransaction(db, async (tx) => {
    const before = await getAgentDefaults(tx, session.userId);
    await saveAgentDefaults(tx, session.userId, parsed.data);
    await createRedactingRecorder({
      db: tx,
      clock: systemClock,
      dekFor: async () => dek,
    }).record({
      userId: session.userId,
      kind: "agent_defaults_change",
      source: "warthog",
      outcome: "saved",
      payload: { before, after: parsed.data },
    });
  });
  revalidatePath("/settings/agents");
  redirect("/settings/agents?notice=saved");
}
// Save what agents see: the session person's own level only, recorded as their change.
async function saveReadLevel(form: FormData) {
  "use server";
  const { db, session } = await signedIn();
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const result = await createReadLevelActions({ db, clock: systemClock, keyWrapper }).setReadLevel(session, readLevelInputFromForm(form));
  revalidatePath("/settings/agents");
  redirect(`/settings/agents?notice=${readLevelNoticeCode(result)}`);
}
// The controls that apply to every agent, each a full-width row with a 44px target.
const ALL_AGENT_LINKS = [
  { href: "/rules", label: "Manage rules", detail: "Rules for all agents apply on every request." },
  { href: "/agents", label: "Manage individual agents", detail: "Change what one agent can use." },
  { href: "/activity", label: "All activity", detail: "What every agent did through Warthog." },
] as const;

export default async function AgentDefaultsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { db, session } = await signedIn();
  const defaults = await getAgentDefaults(db, session.userId);
  const readLevel = await getReadLevel(db, session.userId);
  const invalid = params.notice === "invalid";
  const readNotice = readLevelNotice(params.notice);
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Agent defaults"
        description="Starting permissions for agents you connect from now on. Agents you've already connected keep their own settings."
      />
      {params.notice === "saved" ? (
        <PageNotice tone="success">Defaults saved. Agents you've already connected are unchanged.</PageNotice>
      ) : invalid ? (
        <PageNotice tone="error">Nothing was saved. Choose a starting set and a request limit from 1 to 10,000.</PageNotice>
      ) : readNotice ? (
        <PageNotice tone={readNotice.tone}>{readNotice.text}</PageNotice>
      ) : null}
      <ActionForm action={save} className="contents">
        <WorkspacePanel
          title="Defaults for new agents"
          description="You can customise each agent when you connect it. Protected details, cards and sharing always start off."
          footer={<FormSubmit pendingLabel="Saving defaults…">Save defaults</FormSubmit>}
        >
          <PendingFormFields>
            <div className="flex flex-col gap-4">
              <SelectField label="Starting permission set" name="template" defaultValue={defaults.template} width="text">
                <option value="minimal">Minimal</option>
                <option value="standard">Standard</option>
              </SelectField>
              <dl className="grid gap-4 rounded-field bg-surface-muted p-4 text-sm sm:grid-cols-2">
                {CONNECTION_PRESETS.filter(preset => preset.value !== "custom").map(preset => <div key={preset.value}><dt className="font-medium">{preset.label}</dt><dd className="mt-1 leading-relaxed text-fg-muted">{preset.description}</dd></div>)}
              </dl>
              <p className="text-sm text-fg-muted">Warthog always records what an agent does through it.</p>
              <details className="group border-t border-line pt-2" open={invalid}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden">
                  Advanced
                  <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
                </summary>
                <div className="pb-2">
                  <Field
                    name="rateLimit"
                    label="Maximum requests per minute"
                    hint="How often each new agent may call Warthog. The default is 120."
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10000}
                    required
                    width="code"
                    error={invalid ? "Enter a whole number from 1 to 10,000." : undefined}
                    defaultValue={defaults.rateLimit}
                  />
                </div>
              </details>
            </div>
          </PendingFormFields>
        </WorkspacePanel>
      </ActionForm>
      <ActionForm action={saveReadLevel} className="contents">
        <WorkspacePanel
          title="What agents see in your email and files"
          description="Warthog checks what every agent reads through your connected services, including agents already connected. Choose how much it hides."
          footer={<FormSubmit pendingLabel="Saving…">Save</FormSubmit>}
        >
          <PendingFormFields>
            {/* Keyed on the saved level, so a save that changes it starts the choices afresh. */}
            <ReadLevelChoices key={readLevel} level={readLevel} />
          </PendingFormFields>
        </WorkspacePanel>
      </ActionForm>
      <WorkspacePanel
        title="Controls for all agents"
        description="Rules for all agents apply on every request, including agents already connected, and an agent's own settings can't override them."
      >
        <ul role="list" className="-my-3 flex flex-col">
          {ALL_AGENT_LINKS.map((link) => (
            <li key={link.href} className="border-b border-line last:border-0">
              <a href={link.href} className="group flex min-h-11 items-center justify-between gap-3 py-3 text-sm">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-fg underline-offset-4 group-hover:underline">{link.label}</span>
                  <span className="text-fg-muted">{link.detail}</span>
                </span>
                <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-fg-muted" />
              </a>
            </li>
          ))}
        </ul>
      </WorkspacePanel>
    </div>
  );
}
