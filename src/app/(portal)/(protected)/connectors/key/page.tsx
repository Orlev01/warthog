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
import { Field } from "@/components/ui/field";
import { FormSubmit } from "@/components/ui/form-submit";
import { Notice } from "@/components/ui/notice";

export const metadata = { title: "Connect a service account" };
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
  if (!parsed.success) redirect("/connectors?notice=problem");
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
  return (
    <PageContainer className="flex flex-col gap-6">
      <a href="/connectors" className="text-sm text-accent underline">
        All service accounts
      </a>
      <h1 className="text-2xl font-semibold tracking-tight">
        Connect {entry.name}
      </h1>
      <Notice tone="info" announce={false}>
        This saves a service account. Choose which agents may use it from their
        Connectors settings after saving.
      </Notice>
      {entry.instructions ? (
        <p className="whitespace-pre-wrap text-sm text-fg-muted">
          {entry.instructions}
        </p>
      ) : null}
      <form action={save} className="flex flex-col gap-4">
        <input type="hidden" name="connectorId" value={entry.id} />
        <Field
          name="accountLabel"
          label="Account name"
          placeholder="For example, personal or work"
          maxLength={200}
          required
        />
        <Field
          name="apiKey"
          label={
            entry.auth_kind === "basic"
              ? "Service credential"
              : "Service access key"
          }
          type="password"
          autoComplete="off"
          maxLength={16384}
          required
        />
        <p className="text-sm text-fg-muted">
          The credential is encrypted and is never shown to your agents. Use a
          key with only the permissions this service needs.
        </p>
        <div>
          <FormSubmit pendingLabel="Saving account…">
            Save service account
          </FormSubmit>
        </div>
      </form>
    </PageContainer>
  );
}
