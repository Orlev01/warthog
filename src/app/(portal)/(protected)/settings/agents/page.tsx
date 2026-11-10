import * as React from "react";
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
import { PageContainer } from "@/components/shell/page-container";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { FormSubmit } from "@/components/ui/form-submit";
import { Notice } from "@/components/ui/notice";

export const metadata = { title: "Global agent settings" };
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
export default async function GlobalAgentSettings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { db, session } = await signedIn();
  const defaults = await getAgentDefaults(db, session.userId);
  return (
    <PageContainer className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Global agent settings
      </h1>
      <p className="text-sm text-fg-muted">
        Choose starting settings for new agents. Each connection keeps its own
        permissions, and you review access when connecting it. Existing agents
        keep their settings.
      </p>
      {params.notice === "saved" ? (
        <Notice tone="success">
          Defaults saved. Existing agents are unchanged.
        </Notice>
      ) : params.notice === "invalid" ? (
        <Notice tone="error">
          Choose a starting set and a request limit between 1 and 10,000.
        </Notice>
      ) : null}
      <form action={save} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-sm font-medium">
          Starting permission set
          <Select name="template" defaultValue={defaults.template}>
            <option value="minimal">Minimal</option>
            <option value="standard">Standard</option>
          </Select>
        </label>
        <p className="text-sm text-fg-muted">
          Minimal includes everyday profile, preferences and assigned skills.
          Standard also includes memory, tasks and records. Services are always
          individually selected. Sensitive identity and card requests stay off
          unless you enable them.
        </p>
        <Field
          name="rateLimit"
          label="Default requests per minute"
          type="number"
          min={1}
          max={10000}
          required
          defaultValue={defaults.rateLimit}
        />
        <div>
          <FormSubmit pendingLabel="Saving defaults…">Save defaults</FormSubmit>
        </div>
      </form>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Controls for all agents</h2>
        <p className="text-sm text-fg-muted">
          Global rules are enforced on every request, including for agents
          already connected. A global denial takes precedence over an agent’s
          settings.
        </p>
        <div className="flex flex-wrap gap-4">
          <a className="text-sm text-accent underline" href="/rules">
            Manage global rules
          </a>
          <a className="text-sm text-accent underline" href="/agents">
            Manage individual agents
          </a>
          <a className="text-sm text-accent underline" href="/activity">
            All-agent audit log
          </a>
        </div>
      </section>
    </PageContainer>
  );
}
