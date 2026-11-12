"use client";

import * as React from "react";
import { ArrowRight, Bot, ShieldCheck, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { createFormSubmissionGuard } from "@/components/ui/form-submit";
import type { PermissionTemplate } from "@/domain/permissions/templates";
import { connectionChoices, type ConnectionChoices, type ConnectionService } from "@/domain/permissions/connection-choices";
import { ConnectionPermissions, ConnectionAccessSummary, PermissionHelp } from "./connection-permissions";

export type ConsentViewService = ConnectionService;
export type ConsentToggleState = ConnectionChoices;
export const consentToggleState = connectionChoices;
export type ConsentDecisionResult = void | { error: string };
export type ConsentViewProps = {
  platform: string;
  defaultName?: string;
  requestedScopes: readonly string[];
  services?: readonly ConsentViewService[];
  template: PermissionTemplate;
  redirect: { host: string; verified: boolean };
  approveAction?: (formData: FormData) => ConsentDecisionResult | Promise<ConsentDecisionResult>;
  refuseAction?: (formData: FormData) => void | Promise<void>;
  currency?: string;
  initialState?: ConsentToggleState;
};

function ConsentButtons({ live, canRefuse, pending, ready, decision }: { live: boolean; canRefuse: boolean; pending: boolean; ready: boolean; decision: "approve" | "refuse" }) {
  return <div className="wh-connection-actions">
    <Button type={live ? "submit" : "button"} data-decision="approve" disabled={live && !ready} aria-disabled={pending || undefined} aria-busy={pending && decision === "approve"} onClick={e => { if (pending) e.preventDefault(); }}>
      {pending && decision === "approve" ? "Connecting…" : "Approve connection"}<ArrowRight size={16} aria-hidden="true" />
    </Button>
    <Button type={canRefuse ? "submit" : "button"} data-decision="refuse" formNoValidate={canRefuse} disabled={live && !ready} variant="secondary" aria-disabled={pending || undefined} aria-busy={pending && decision === "refuse"} onClick={e => { if (pending) e.preventDefault(); }}>
      {pending && decision === "refuse" ? "Refusing…" : "Refuse"}
    </Button>
  </div>;
}

export function ConsentView({ platform, defaultName, requestedScopes, services = [], template, redirect, approveAction, refuseAction, currency = "AUD", initialState }: ConsentViewProps) {
  const [startingSet, setStartingSet] = React.useState<PermissionTemplate>(initialState ? "custom" : template);
  const [state, setState] = React.useState(() => initialState ?? connectionChoices(template, services.filter(s => s.ticked).map(s => s.id)));
  const [pending, startTransition] = React.useTransition();
  const [ready, setReady] = React.useState(false);
  const [decision, setDecision] = React.useState<"approve" | "refuse">("approve");
  React.useEffect(() => setReady(true), []);
  const [error, setError] = React.useState<string | null>(null);
  const guard = React.useRef(createFormSubmissionGuard()).current;
  const id = React.useId();
  const edit = (next: ConnectionChoices) => { setState(next); setStartingSet("custom"); };
  const choose = (next: PermissionTemplate) => {
    setStartingSet(next);
    if (next !== "custom") setState(connectionChoices(next, services.filter(s => s.ticked).map(s => s.id)));
  };
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending || !guard.reserve()) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const nextDecision = submitter?.getAttribute("data-decision") === "refuse" ? "refuse" : "approve";
    const data = new FormData(event.currentTarget);
    setDecision(nextDecision);
    setError(null);
    startTransition(async () => {
      await guard.run(async values => {
        if (nextDecision === "refuse") await refuseAction?.(values);
        else {
          const result = await approveAction?.(values);
          if (result?.error) setError(result.error);
        }
      }, data);
    });
  }

  const content = <div className="wh-connection-flow">
    <header className="wh-connection-intro">
      <span className="wh-connection-mark"><Bot size={24} strokeWidth={1.5} aria-hidden="true" /></span>
      <p className="wh-connection-eyebrow">Agent connection</p>
      <h1>Connect {platform}</h1>
      <p>You’re giving this agent a way to use information and services in Warthog. Choose its access before you connect.</p>
    </header>
    <fieldset className="contents" disabled={pending || (!!approveAction && !ready)}>
      <section className="wh-connection-section" aria-labelledby={`${id}-identity`}>
        <div className="wh-connection-section-heading"><span>01</span><div><h2 id={`${id}-identity`}>Confirm the connection</h2><p>Check where you’re returning and give this agent a recognisable name.</p></div></div>
        <div className="wh-connection-destination">
          <div><span>Connecting back to</span><strong>{redirect.host}</strong></div>
          <span className={redirect.verified ? "text-success" : "text-warning"}>{redirect.verified ? <ShieldCheck size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}{redirect.verified ? "Verified platform" : "Unrecognised platform"}</span>
        </div>
        <p className="text-sm text-fg-muted">{redirect.verified ? "The return address matches a platform Warthog recognises. This badge does not verify the agent’s behaviour or the safety of a request." : "We do not recognise this platform. Check the full address and only continue if you started this connection and trust its destination."}</p>
        <div className="wh-connection-name"><Field label="Agent name" name="name" defaultValue={defaultName ?? platform} placeholder="For example, Claude · research" required maxLength={200} aria-describedby={`${id}-name-help`} /></div>
        <p id={`${id}-name-help`} className="text-sm text-fg-muted">This name appears in your agent list, approval requests and activity. It does not rename your account on {platform}.</p>
        <PermissionHelp label={`What ${platform} is asking for`}><ul className="list-disc pl-5">{requestedScopes.map((scope, i) => <li key={i}>{scope}</li>)}</ul><p className="mt-2">The choices below apply to this connection. They do not connect other agents or give it access to everything in your account.</p></PermissionHelp>
      </section>
      <ConnectionPermissions template={startingSet} state={state} services={services} onTemplate={choose} onChange={edit} currency={currency} />
      <section className="wh-connection-section wh-connection-review" aria-labelledby={`${id}-review`}>
        <div className="wh-connection-section-heading"><span>03</span><div><h2 id={`${id}-review`}>Review before you connect</h2><p>Your current choices — {startingSet === "custom" ? "Custom" : startingSet === "minimal" ? "Minimal" : "Standard"}.</p></div></div>
        <ConnectionAccessSummary state={state} services={services} currency={currency} />
        <p className="wh-connection-boundary">Your global rules still apply. These permissions cover requests through Warthog, not the platform’s separate tools or activity.</p>
        <PermissionHelp label="What happens after I approve?">Warthog creates a separate agent connection and returns you to {redirect.host} to finish setup. You can change its permissions or disconnect it in Agents. Disconnecting stops future Warthog access; it cannot recall information already received. Refusing creates no connection.</PermissionHelp>
      </section>
    </fieldset>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <ConsentButtons live={!!approveAction} canRefuse={!!refuseAction} pending={pending} ready={ready} decision={decision} />
    <p className="wh-connection-footer">Only approve a connection you started and recognise.</p>
  </div>;
  // Event-driven submission avoids React's successful-action form reset on a
  // handled validation error. Capture FormData before freezing fields; keep the
  // initiating button focused. Server actions still own identity and authority.
  return approveAction ? <form method="post" onSubmit={submit}>{content}<noscript>Enable JavaScript to review and approve this connection.</noscript></form> : content;
}

export default ConsentView;
