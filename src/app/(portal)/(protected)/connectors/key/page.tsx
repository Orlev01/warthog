import * as React from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerDb } from "@/server/db/server";
import { withTransaction } from "@/server/db/index";
import { getUserById } from "@/server/db/users";
import { verifySession } from "@/server/auth/session";
import { loadConfig } from "@/server/config";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import { saveApiKeyConnection } from "@/server/connectors/api-key";
import { createGuardedProviderFetch } from "@/server/connectors/provider-mcp";
import { createRedactingRecorder } from "@/server/mcp/recorder";
import { systemClock } from "@/server/seams/clock";
import { PageContainer } from "@/components/shell/page-container";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Field } from "@/components/ui/field";
import { ButtonLink } from "@/components/ui/button-link";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { PageNotice } from "@/components/ui/notice";
import type { Metadata } from "next";

// Its own title in the "Page · Warthog" pattern: what the page is for, distinct from the
// Connectors page above it. `absolute`, because the Connectors layout's own string title
// would otherwise drop the site's suffix on this nested page (content-24).
export const metadata: Metadata = { title: { absolute: "Connect a service · Warthog" } };

// A key or name made only of spaces is refused like an empty one (trimmed first).
const NOT_BLANK = ".*\\S.*";
const inputSchema = z.object({
  connectorId: z.string().min(1).max(200),
  accountLabel: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(16384),
});
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
  const parsed = inputSchema.safeParse(
    Object.fromEntries(
      ["connectorId", "accountLabel", "apiKey"].map((key) => [
        key,
        form.get(key),
      ]),
    ),
  );
  // A missing account name or key goes back to this form with the reason, not to the
  // Connectors page (the person's place and the service they chose are kept).
  if (!parsed.success) {
    const connectorId = form.get("connectorId");
    redirect(
      typeof connectorId === "string" && connectorId.length > 0 && connectorId.length <= 200
        ? `/connectors/key?connector=${encodeURIComponent(connectorId)}&notice=missing`
        : "/connectors?view=catalogue&notice=connect-problem",
    );
  }
  const input = parsed.data;
  const entry = getProcessCatalogue().get(input.connectorId);
  if (!entry || !["api_key", "basic"].includes(entry.auth_kind)) notFound();
  const user = await getUserById(db, session.userId);
  if (!user) redirect("/signin");
  const config = loadConfig();
  const dek = await selectKeyWrapper({
    nodeEnv: config.nodeEnv,
    localKek: config.devKek,
  }).unwrap(user.wrappedDek);
  const result = await withTransaction(db, async (tx) => {
    const saved = await saveApiKeyConnection(
      { ...input, entry, userId: session.userId, dek },
      { db: tx, clock: systemClock, fetch: createGuardedProviderFetch() },
    );
    await createRedactingRecorder({
      db: tx,
      clock: systemClock,
      dekFor: async () => dek,
    }).record({
      userId: session.userId,
      kind: "connection_change",
      source: "warthog",
      connectorId: entry.id,
      outcome: saved.connection.status,
      payload: { service: entry.name, account: input.accountLabel },
    });
    return saved.connection.status;
  });
  revalidatePath("/connectors");
  redirect(
    `/connectors?notice=${result === "connected" ? "key-saved" : "verification-failed"}`,
  );
}
export default async function ConnectKeyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  await signedIn();
  const entry =
    typeof params.connector === "string"
      ? getProcessCatalogue().get(params.connector)
      : undefined;
  if (!entry || !["api_key", "basic"].includes(entry.auth_kind)) notFound();
  const missing = params.notice === "missing";
  const keyLabel = entry.auth_kind === "basic" ? "API key or password" : "API key";
  return (
    <PageContainer>
      <WorkspaceHeading
        title={`Connect ${entry.name}`}
        description={`Paste a ${keyLabel === "API key" ? "key" : "key or password"} from your ${entry.name} account. Afterwards, you choose which agents can use it on each agent's page.`}
      />
      {missing ? (
        <PageNotice tone="error">Enter a name for this account and your {keyLabel}, then save.</PageNotice>
      ) : null}
      <ActionForm action={save}>
        <input type="hidden" name="connectorId" value={entry.id} />
        <WorkspacePanel
          title={`Your ${entry.name} account`}
          description="We encrypt your key and never show it to your agents. Use a key with only the permissions this service needs."
          footer={
            <>
              <FormSubmit pendingLabel="Saving…">Save and connect</FormSubmit>
              <ButtonLink href="/connectors?view=catalogue" variant="ghost">
                Cancel
              </ButtonLink>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {entry.instructions ? (
              <div className="rounded-card bg-surface-muted p-4">
                <p className="text-sm font-medium text-fg">Where to find it</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-fg-muted [overflow-wrap:anywhere]">
                  {entry.instructions}
                </p>
              </div>
            ) : null}
            <Field
              name="accountLabel"
              label="Account name"
              hint="So you can tell your accounts apart."
              placeholder="For example, personal or work"
              maxLength={200}
              pattern={NOT_BLANK}
              title="Enter a name for this account."
              width="text"
              required
            />
            <Field
              name="apiKey"
              label={keyLabel}
              type="password"
              autoComplete="off"
              maxLength={16384}
              pattern={NOT_BLANK}
              title={`Enter your ${keyLabel}.`}
              width="text"
              required
            />
          </div>
        </WorkspacePanel>
      </ActionForm>
    </PageContainer>
  );
}
