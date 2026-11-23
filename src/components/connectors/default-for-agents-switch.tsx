"use client";

import * as React from "react";
import { ActionForm, PendingFormFields } from "@/components/ui/form-submit";

// "On for new agents" for one account under Your services (docs/adr/default-services.md). A
// native checkbox with the switch role: flipping it saves straight away (the same guarded,
// one-submission form as every other control on the page), and the page comes back with the
// outcome. Without an action it is shown disabled with its reason, never live over nothing.
export function DefaultForAgentsSwitch({
  connectionId,
  accountLabel,
  service,
  on,
  otherAccount,
  action,
}: {
  connectionId: string;
  accountLabel: string;
  service: string;
  on: boolean;
  // Another account of this service that new agents use today, if any.
  otherAccount?: string;
  action?: (formData: FormData) => void | Promise<void>;
}) {
  const description = on
    ? `Every agent you connect from now on starts with ${service}, using this account.`
    : otherAccount
      ? `New agents use ${otherAccount} for ${service}. Turn this on to use this account instead.`
      : `Turn on to start every agent you connect from now on with ${service}, using this account.`;
  const control = (
    <label className="flex min-h-11 items-start gap-3 rounded-field bg-surface-muted px-3 py-2.5">
      <input
        type="checkbox"
        role="switch"
        name="on"
        defaultChecked={on}
        disabled={!action}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => event.currentTarget.form?.requestSubmit()}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">
          On for new agents<span className="sr-only"> ({accountLabel})</span>
        </span>
        <span className="text-sm text-fg-muted">
          {description} Agents already connected don&apos;t change.
        </span>
      </span>
    </label>
  );
  if (!action) {
    return (
      <div className="flex flex-col gap-1">
        {control}
        <p className="text-xs text-fg-muted">Changing this isn&apos;t available just now.</p>
      </div>
    );
  }
  return (
    <ActionForm action={action}>
      <PendingFormFields pendingLabel="Saving…">
        <input type="hidden" name="connectionId" value={connectionId} />
        <input type="hidden" name="return_view" value="connected" />
        {control}
      </PendingFormFields>
    </ActionForm>
  );
}
