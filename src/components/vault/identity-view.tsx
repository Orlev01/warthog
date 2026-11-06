"use client";

import * as React from "react";
import { ArrowUp, Lock, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { SensitiveNotice } from "@/components/ui/sensitive-notice";
import { encryptValue } from "@/client/vault/values";

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
// This is the render-testable, prop-driven VIEW (a Client Component in the app).
// Holding the unlocked vault key, POSTing the sealed submission and the server
// action that stores it are wired by a LATER task; here the controls are native and
// a PROP (`addingHighTier`) selects the initial state of the add panel, exactly the
// `draft` idiom of the sibling rules / consent / notifications views.
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

// The sensitive-moment explainer: HOW the detail is protected (sealed on the
// device, never readable by Warthog) and WHO can ever read it (only the person,
// only when they approve a release) — plain words, no protocol jargon.
const PROTECTION_EXPLAINER =
  "This detail is locked on your device with your vault key before it is saved — only the sealed version ever leaves, and Warthog can never read it. It is released only when you approve it for one agent at one moment; no one else, not even Warthog's team, can ever see it.";

// The moving-on date as the ISO "YYYY-MM-DD" a date input shows (a Date is cast to
// text; a plain string is used as-is; absent ⇒ empty).
function isoDate(value: string | Date | null): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

// --- field cards -------------------------------------------------------------------

// A low-tier field: editable in place, a postal address also carrying its moving-on
// date, with a "Raise to high tier" control that re-seals it on the device.
function LowTierCard({ field }: { field: LowTierField }) {
  const label = LOW_TIER_LABELS[field.kind];
  const isAddress = field.kind === "postal_address";
  return (
    <Card className="flex flex-col gap-3">
      <Field label={label} defaultValue={field.value} />
      {isAddress ? (
        <Field label="Moving on" type="date" defaultValue={isoDate(field.movingOn)} />
      ) : null}
      <div className="flex">
        <Button variant="secondary" type="button">
          <ArrowUp aria-hidden={true} className="h-4 w-4 shrink-0" />
          Raise to high tier
        </Button>
      </div>
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

// The "add a high-tier detail" panel, shown at the sensitive moment: the plain
// protection explainer, a live value-entry field, and the explicit confirm. The
// entered value is sealed on the device (sealHighTierDetail) by the later wiring
// before anything leaves.
function AddHighTierPanel() {
  return (
    <Card className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-fg">Add a high-tier detail</h3>
      <Field label="What is it?" placeholder="e.g. Passport" />
      <Field label="The detail" placeholder="Type the detail to protect" />
      <SensitiveNotice explanation={PROTECTION_EXPLAINER} />
    </Card>
  );
}

export function IdentityView({ lowTierFields, highTierFields, addingHighTier = false }: IdentityViewProps) {
  return (
    <section className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold text-fg">About you</h1>

      {/* ----- Low-tier: your everyday details, editable in place ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg">Your details</h2>
        {lowTierFields.map((field) => (
          <LowTierCard key={field.id} field={field} />
        ))}
      </div>

      {/* ----- High-tier: protected details, locked on the device ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg">Protected details</h2>
        {highTierFields.map((field) => (
          <HighTierCard key={field.id} field={field} />
        ))}
        {addingHighTier ? (
          <AddHighTierPanel />
        ) : (
          <div className="flex">
            <Button variant="primary" type="button">
              <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
              Add a high-tier detail
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

export default IdentityView;
