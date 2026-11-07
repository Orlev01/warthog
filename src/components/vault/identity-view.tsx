"use client";

import * as React from "react";
import { Lock } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { encryptValue } from "@/client/vault/values";
import {
  HighTierFlow,
  type RaiseFieldToHighTierAction,
  type SaveHighTierFieldAction,
} from "./high-tier-flow";

// E11-S13 — Vault identity view component (brief "Identity vault"; design §4.1
// low tier + §4.2 device-held vault; primary journey "About you").
//
// The identity page is the primary-journey "About you" surface. It renders every
// tier FROM PROPS and never contradicts the device-held-vault rule:
//   - LOW-tier fields (name, email, phone, a postal address with a "moving on"
//     date, …) are handed back DECRYPTED and rendered EDITABLE in place, each with
//     a "Raise to high tier" control;
//   - HIGH-tier fields are handed back as METADATA ONLY (label + type + tier, never
//     a value or its ciphertext) and rendered LOCKED — label + tier, never a value;
//   - an "Add a high-tier detail" control opens, at that sensitive moment, the plain
//     explainer of HOW the detail is protected (sealed on the device) and WHO can
//     ever read it (only when the person approves).
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The
// "Add a high-tier detail" panel AND each low-tier field's "Raise to high tier" control
// are now LIVE on-device flows: the view mounts E11-S20's <HighTierFlow/> for both (its
// device behaviour — create/unlock the vault key → seal → submit only ciphertext +
// metadata to the page's saveHighTierField / raiseFieldToHighTier actions — is pinned by
// high-tier-flow.test.tsx). A PROP (`addingHighTier`) selects the initial state of the
// add panel, exactly the `draft` idiom of the sibling rules / consent / notifications views.
//
// The one off-device obligation — "the value is sealed with the vault key on the
// device before it is sent (only ciphertext leaves)" — is the exported pure
// `sealHighTierDetail` below: it seals the value with the browser vault-value
// encryption (`@/client/vault/values`) and returns a submission carrying ONLY the
// `v1:` ciphertext plus the plaintext metadata, never the plaintext value.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.

// --- prop shapes (declared locally so this client VIEW never couples to the server
// db modules; these mirror VaultPageData.lowTierFields / .highTierFields) ----------

export type LowTierFieldKind =
  | "name"
  | "preferred_name"
  | "email"
  | "phone"
  | "postal_address"
  | "language"
  | "time_zone"
  | "preference";

// A low-tier field as its owner is handed it back: value DECRYPTED, plus the
// optional "moving on" date a postal address may carry (ISO "YYYY-MM-DD").
export type LowTierField = {
  id: string;
  userId: string;
  kind: LowTierFieldKind;
  value: string;
  movingOn: string | Date | null;
};

export type HighTierFieldType =
  | "date_of_birth"
  | "passport"
  | "driver_licence"
  | "car_registration"
  | "custom";

// A high-tier field as its owner is handed it back: METADATA ONLY — no value, no
// ciphertext.
export type HighTierField = {
  id: string;
  userId: string;
  type: HighTierFieldType;
  label: string;
  tier: "high";
};

export type IdentityViewProps = {
  lowTierFields: ReadonlyArray<LowTierField>;
  highTierFields: ReadonlyArray<HighTierField>;
  // Selects the initial state of the "add a high-tier detail" panel. When true the
  // panel is OPEN (explainer + value field + confirm); defaults to CLOSED.
  addingHighTier?: boolean;
  // The submit seams the now-live add / raise flows (<HighTierFlow/>) post to — the
  // page's saveHighTierField / raiseFieldToHighTier server actions that store the
  // device-sealed submission. The page always supplies the real actions; a prop-driven
  // render (a preview, a render test) may omit them, in which case nothing is stored.
  saveHighTierField?: SaveHighTierFieldAction;
  raiseFieldToHighTier?: RaiseFieldToHighTierAction;
};

// The high-tier detail a person enters, before it is sealed on the device.
export type HighTierDetail = {
  type: HighTierFieldType;
  label: string;
  value: string;
};

// What leaves the device for the server to store: the plaintext metadata plus ONLY
// the sealed `v1:` ciphertext — never the plaintext value (the server holds no key).
export type HighTierSubmission = {
  type: HighTierFieldType;
  label: string;
  ciphertext: string;
};

// --- the device-seal step (the one off-device obligation) --------------------------
//
// Seal `detail.value` under the in-memory vault key and return the submission the
// server stores. The value is encrypted IN THE BROWSER with the vault key (the
// `v1:` envelope that round-trips under the SAME key via decryptValue); only that
// ciphertext and the plaintext metadata (type, label) leave the device.
export async function sealHighTierDetail(
  vaultKey: Uint8Array<ArrayBuffer>,
  detail: HighTierDetail,
): Promise<HighTierSubmission> {
  const ciphertext = await encryptValue(vaultKey, detail.value);
  return { type: detail.type, label: detail.label, ciphertext };
}

// --- plain copy --------------------------------------------------------------------

// Each low-tier field's plain label (Australian English, no jargon).
const LOW_TIER_LABELS: Record<LowTierFieldKind, string> = {
  name: "Name",
  preferred_name: "Preferred name",
  email: "Email",
  phone: "Phone",
  postal_address: "Postal address",
  language: "Language",
  time_zone: "Time zone",
  preference: "Preference",
};

// The moving-on date as the ISO "YYYY-MM-DD" a date input shows (a Date is cast to
// text; a plain string is used as-is; absent ⇒ empty).
function isoDate(value: string | Date | null): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

// --- field cards -------------------------------------------------------------------

// A low-tier field: editable in place, a postal address also carrying its moving-on
// date, with a live "Raise to high tier" flow that re-seals its current value on the
// device and submits only the ciphertext + metadata (the device behaviour is pinned by
// high-tier-flow.test.tsx).
function LowTierCard({
  field,
  raiseFieldToHighTier,
}: {
  field: LowTierField;
  raiseFieldToHighTier?: RaiseFieldToHighTierAction;
}) {
  const label = LOW_TIER_LABELS[field.kind];
  const isAddress = field.kind === "postal_address";
  return (
    <Card className="flex flex-col gap-3">
      <Field label={label} defaultValue={field.value} />
      {isAddress ? (
        <Field label="Moving on" type="date" defaultValue={isoDate(field.movingOn)} />
      ) : null}
      <HighTierFlow
        mode="raise"
        field={{ id: field.id, value: field.value, label }}
        raiseFieldToHighTier={raiseFieldToHighTier}
      />
    </Card>
  );
}

// A high-tier field: LOCKED — its label and tier shown in words, never its value
// (the view is only ever handed metadata).
function HighTierCard({ field }: { field: HighTierField }) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{field.label}</span>
        <span className="inline-flex items-center gap-1.5 rounded-card border border-line bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
          <Lock aria-hidden={true} className="h-3.5 w-3.5 shrink-0" />
          High tier
        </span>
      </div>
      <p className="text-sm text-fg-muted">
        Locked on your device — released only when you approve it.
      </p>
    </Card>
  );
}

export function IdentityView({
  lowTierFields,
  highTierFields,
  addingHighTier = false,
  saveHighTierField,
  raiseFieldToHighTier,
}: IdentityViewProps) {
  return (
    <section className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold text-fg">About you</h1>

      {/* ----- Low-tier: your everyday details, editable in place ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg">Your details</h2>
        {lowTierFields.map((field) => (
          <LowTierCard key={field.id} field={field} raiseFieldToHighTier={raiseFieldToHighTier} />
        ))}
      </div>

      {/* ----- High-tier: protected details, locked on the device ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg">Protected details</h2>
        {highTierFields.map((field) => (
          <HighTierCard key={field.id} field={field} />
        ))}
        {/* The live on-device add flow: closed it is the "Add a high-tier detail"
            control, open it seals the value under the vault key and submits only
            ciphertext + metadata. */}
        <HighTierFlow mode="add" saveHighTierField={saveHighTierField} initialOpen={addingHighTier} />
      </div>
    </section>
  );
}

export default IdentityView;
