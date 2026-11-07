import * as React from "react";
import { ShieldCheck, AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
  permissionTemplate,
  type PermissionSet,
  type PermissionTemplate,
} from "@/domain/permissions/templates";

// E10-S02 — Agent consent view (design §6.1; brief "Agent consent screen").
//
// When an agent starts connecting, the signed-in person names it, sees what it is
// asking for in plain words, picks a starting permission set (Minimal / Standard /
// Custom), adjusts the individual toggles, sees whether the platform calling back
// is a known/verified one, and Approves or Refuses — all on ONE screen.
//
// This is the PURE, prop-driven view: it renders the screen from its props so it
// can be pinned without a browser, a session or any protocol machinery. The real
// OAuth/consent plumbing (deciding the redirect host, issuing the credential on
// approve, persisting the adjusted set) lives in the server composition root and
// is wired by a later task; the controls here are native, user-adjustable form
// controls whose initial state is driven by the chosen `template`.
//
// The grants a starting set produces are the one-source-of-truth domain contract
// @/domain/permissions/templates — this view hard-codes none of the rules; it
// computes the set and reflects it. Colour comes from the design tokens
// (globals.css) — never a raw hex.

export type ConsentViewService = {
  id: string;
  name: string;
  ticked?: boolean;
};

export type ConsentViewProps = {
  // the connecting agent's platform (e.g. "Claude"), named on the screen.
  platform: string;
  // the proposed name for the agent, pre-filled into the editable name field.
  defaultName?: string;
  // what the agent asked for, each a plain-words line shown verbatim.
  requestedScopes: ReadonlyArray<string>;
  // the person's connectable services; the ticked ones' read tools are granted
  // under Standard/Custom with their change-making tools set to "Ask me first".
  services?: ReadonlyArray<ConsentViewService>;
  // the selected starting set; it drives which toggles render ON.
  template: PermissionTemplate;
  // a KNOWN platform callback (verified) shows the "Verified platform" badge; any
  // other host is shown prominently.
  redirect: { host: string; verified: boolean };
  // E10-S12 — the server decision actions the live consent screen submits to. When
  // given, the view becomes a real form: Approve submits the chosen name, starting set
  // and opt-ins to `approveAction`; Refuse submits to `refuseAction`. When omitted the
  // view renders as the pure, presentational screen (E10-S02) — no form, inert buttons.
  approveAction?: (formData: FormData) => void | Promise<void>;
  refuseAction?: (formData: FormData) => void | Promise<void>;
};

// The three starting sets the consent screen offers, in plain words.
const STARTING_SETS: ReadonlyArray<{
  value: PermissionTemplate;
  label: string;
  description: string;
}> = [
  { value: "minimal", label: "Minimal", description: "Just the low-tier basics." },
  { value: "standard", label: "Standard", description: "The recommended balance." },
  { value: "custom", label: "Custom", description: "Start from Standard, then change anything." },
];

// Every grantable capability, keyed to its boolean field on the computed
// PermissionSet, described in the brief's own plain words. High-tier, card and
// sharing-what-it-learns are always opt-in (off in every starting set).
type BooleanCapability = Exclude<keyof PermissionSet, "services">;

// The opt-in capabilities a person can turn ON from the live consent form (always off
// in every starting set). High-tier and sharing-what-it-learns are simple booleans and
// are submitted by name; card access needs a budget, which is set up on the per-agent
// permissions page, so the card toggle stays a preview here.
const SUBMITTABLE_OPTINS: ReadonlySet<BooleanCapability> = new Set<BooleanCapability>([
  "highTier",
  "learningSharing",
]);

const CAPABILITIES: ReadonlyArray<{ key: BooleanCapability; label: string }> = [
  { key: "lowTierProfile", label: "Your basic profile" },
  { key: "skills", label: "Your skills" },
  { key: "preferences", label: "Your preferences" },
  { key: "activityLogging", label: "Logging its activity" },
  { key: "sharedMemoryRead", label: "Read your shared memory" },
  { key: "ownMemorySave", label: "Save its own memories" },
  { key: "tasks", label: "Your tasks" },
  { key: "lifeAdmin", label: "Your life-admin records" },
  { key: "highTier", label: "High-tier identity requests" },
  { key: "card", label: "Card requests" },
  { key: "learningSharing", label: "Share what it learns" },
];

// One capability toggle: a native, user-adjustable checkbox whose initial checked
// state reflects whether the selected starting set grants it. A `name` makes the
// toggle part of the live form submission (an opt-in the decision reads); without one
// the toggle is a preview of what the starting set grants.
function Toggle({ on, name, children }: { on: boolean; name?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3 rounded-card border border-line bg-surface p-3">
      <input type="checkbox" name={name} defaultChecked={on} className="h-4 w-4 accent-accent" />
      <span className="text-fg">{children}</span>
    </label>
  );
}

// Where the platform calls back to: a verified platform wears a badge; any other
// host is shown prominently with a caution, in words plus an icon (never colour
// alone).
function RedirectNotice({ redirect }: { redirect: ConsentViewProps["redirect"] }) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-muted p-3 text-sm">
      <span className="text-fg-muted">Connecting back to</span>
      <span className="font-medium text-fg">{redirect.host}</span>
      {redirect.verified ? (
        <span className="inline-flex items-center gap-1.5 font-medium text-success">
          <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
          Verified platform
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 font-medium text-warning">
          <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0" />
          We do not recognise this platform. Check the address before you approve.
        </span>
      )}
    </div>
  );
}

export function ConsentView({
  platform,
  defaultName,
  requestedScopes,
  services = [],
  template,
  redirect,
  approveAction,
  refuseAction,
}: ConsentViewProps) {
  const tickedIds = services.filter((s) => s.ticked).map((s) => s.id);
  const permissions = permissionTemplate(template, tickedIds);
  const serviceGranted = (id: string) => permissions.services.some((p) => p.service === id);
  // A live form only when the decision actions are wired in; otherwise the pure view.
  const live = approveAction != null;

  const content = (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-fg">Connect {platform}</h1>
        <p className="text-sm text-fg-muted">
          Name it, choose what it can do, then approve.
        </p>
        <RedirectNotice redirect={redirect} />
      </header>

      <Field label="Name" name="name" defaultValue={defaultName} placeholder={defaultName} />

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">{platform} is asking to</h2>
        <ul className="flex flex-col gap-1.5">
          {requestedScopes.map((scope, i) => (
            <li
              key={i}
              className="rounded-card border border-line bg-surface p-3 text-sm text-fg"
            >
              {scope}
            </li>
          ))}
        </ul>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-medium text-fg">Starting set</legend>
        <div className="flex flex-col gap-2">
          {STARTING_SETS.map((set) => (
            <div key={set.value} className="rounded-card border border-line bg-surface p-3">
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="starting-set"
                  value={set.value}
                  defaultChecked={template === set.value}
                  className="h-4 w-4 accent-accent"
                />
                <span className="font-medium text-fg">{set.label}</span>
              </label>
              <p className="mt-1 text-sm text-fg-muted">{set.description}</p>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-medium text-fg">What it can do</legend>
        <div className="flex flex-col gap-2">
          {CAPABILITIES.map((cap) => (
            <Toggle
              key={cap.key}
              name={live && SUBMITTABLE_OPTINS.has(cap.key) ? cap.key : undefined}
              on={permissions[cap.key]}
            >
              {cap.label}
            </Toggle>
          ))}
        </div>
      </fieldset>

      {services.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">Your services</legend>
          <div className="flex flex-col gap-2">
            {services.map((service) => {
              const granted = serviceGranted(service.id);
              return (
                <div
                  key={service.id}
                  className="flex flex-col gap-1 rounded-card border border-line bg-surface p-3"
                >
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      defaultChecked={granted}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="text-fg">Read from {service.name}</span>
                  </label>
                  {granted ? (
                    <p className="text-sm text-fg-muted">Changes: Ask me first</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type={live ? "submit" : "button"} variant="primary" className="sm:flex-1">
          Approve
        </Button>
        <Button
          type={refuseAction != null ? "submit" : "button"}
          formAction={refuseAction}
          variant="secondary"
          className="sm:flex-1"
        >
          Refuse
        </Button>
      </div>
    </section>
  );

  // When the decision actions are wired in, the whole screen is a form that posts the
  // person's choices to Approve (the form action) or Refuse (the button's formAction);
  // otherwise it is the pure, presentational view.
  return live ? <form action={approveAction}>{content}</form> : content;
}

export default ConsentView;
