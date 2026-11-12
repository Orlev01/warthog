"use client";

import * as React from "react";
import { Lock, ShieldCheck, UserRound } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { encryptValue } from "@/client/vault/values";
import {
  HighTierFlow,
  type RaiseFieldToHighTierAction,
  type SaveHighTierFieldAction,
} from "./high-tier-flow";
import {
  LowTierDetailFlow,
  type SaveLowTierFieldAction,
  type UpdateLowTierFieldAction,
} from "./low-tier-detail-flow";

// E11-S13 — Vault identity view component (brief "Identity vault"; design §4.1
// low tier + §4.2 device-held vault; primary journey "About you").
//
// The identity page is the primary-journey "About you" surface. It renders every
// tier FROM PROPS and never contradicts the device-held-vault rule:
//   - LOW-tier fields (name, email, phone, a postal address with a "moving on"
//     date, …) are handed back DECRYPTED and rendered EDITABLE in place — each a small
//     form whose Save re-saves the value (and an address's moving-on date) through the
//     page's updateLowTierField action — each with a "Raise to high tier" control, and
//     an "Add a detail" form saves a new one through saveLowTierField (review fix G1:
//     these fields used to have no name, no form and no Save, so every edit was lost);
//   - HIGH-tier fields are handed back as METADATA ONLY (label + type + tier, never
//     a value or its ciphertext) and rendered LOCKED — label + tier, never a value;
//   - an "Add a high-tier detail" control opens, at that sensitive moment, the plain
//     explainer of HOW the detail is protected (sealed on the device) and WHO can
//     ever read it (only when the person approves).
//
// Organisation: the page heading band, then one panel per tier — "Everyday details" and
// "Protected details" (the two tier names used everywhere; "low/high tier" is only the
// code's word). Within each, the details are grouped by purpose (names, contact,
// preferences; identity, vehicle, other) under titled groups with their counts, each
// detail a divider row rather than its own card — so an opened panel is never a card
// inside a card. A purpose with no details is not shown. Each everyday detail's Save and
// "Make protected" share one action row; the tier's add control closes its panel. The
// shell's section tabs (About you / Cards) are the Vault's one tab row; the view adds no
// second one.
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
  // The submit seams of the low-tier add / edit forms — the page's saveLowTierField /
  // updateLowTierField server actions (the value is DEK-encrypted server-side).
  saveLowTierField?: SaveLowTierFieldAction;
  updateLowTierField?: UpdateLowTierFieldAction;
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

// --- purpose groups ----------------------------------------------------------------

// The everyday details, grouped by what they are for, in reading order. Every kind is
// in exactly one group, so no detail can be dropped.
const LOW_TIER_GROUPS: ReadonlyArray<{ id: string; title: string; kinds: readonly LowTierFieldKind[] }> = [
  { id: "names", title: "Names", kinds: ["name", "preferred_name"] },
  { id: "contact", title: "Contact", kinds: ["email", "phone", "postal_address"] },
  { id: "preferences", title: "Preferences", kinds: ["language", "time_zone", "preference"] },
];

// The protected details, grouped by kind. A custom detail (and any kind added later)
// lands in "Other", so no detail can be dropped.
const HIGH_TIER_GROUPS: ReadonlyArray<{ id: string; title: string; types: readonly HighTierFieldType[] }> = [
  { id: "identity", title: "Identity", types: ["date_of_birth", "passport", "driver_licence"] },
  { id: "vehicle", title: "Vehicle", types: ["car_registration"] },
];

// `fields` in their groups, in group order, keeping each group's kind order and then the
// order the fields arrived in; groups with nothing in them are left out.
function groupLowTier(fields: ReadonlyArray<LowTierField>) {
  return LOW_TIER_GROUPS.map((group) => ({
    ...group,
    fields: group.kinds.flatMap((kind) => fields.filter((field) => field.kind === kind)),
  })).filter((group) => group.fields.length > 0);
}

function groupHighTier(fields: ReadonlyArray<HighTierField>) {
  const grouped = HIGH_TIER_GROUPS.map((group) => ({
    ...group,
    fields: group.types.flatMap((type) => fields.filter((field) => field.type === type)),
  }));
  const known = new Set(HIGH_TIER_GROUPS.flatMap((group) => group.types));
  grouped.push({ id: "other", title: "Other", types: [], fields: fields.filter((field) => !known.has(field.type)) });
  return grouped.filter((group) => group.fields.length > 0);
}

// --- field rows --------------------------------------------------------------------

// A low-tier field: editable in place (a postal address also carrying its moving-on
// date) with a Save that re-saves it through updateLowTierField, plus a live "Raise to
// high tier" flow that re-seals its current value on the device and submits only the
// ciphertext + metadata (the device behaviour is pinned by high-tier-flow.test.tsx).
function LowTierRow({
  field,
  raiseFieldToHighTier,
  updateLowTierField,
}: {
  field: LowTierField;
  raiseFieldToHighTier?: RaiseFieldToHighTierAction;
  updateLowTierField?: UpdateLowTierFieldAction;
}) {
  const label = LOW_TIER_LABELS[field.kind];
  return (
    <li className={`${LIST_ROW} py-4`}>
      <LowTierDetailFlow
        mode="edit"
        field={field}
        label={label}
        updateLowTierField={updateLowTierField}
        actions={
          <HighTierFlow
            mode="raise"
            field={{ id: field.id, value: field.value, label }}
            raiseFieldToHighTier={raiseFieldToHighTier}
          />
        }
      />
    </li>
  );
}

// A protected field: LOCKED — its label and tier shown in words, never its value
// (the view is only ever handed metadata).
function HighTierRow({ field }: { field: HighTierField }) {
  return (
    <li className={LIST_ROW}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{field.label}</span>
        <Badge icon={Lock}>Protected</Badge>
      </div>
      <p className="text-sm text-fg-muted">
        Stored encrypted. An agent has to ask, and you approve each release.
      </p>
    </li>
  );
}

export function IdentityView({
  lowTierFields,
  highTierFields,
  addingHighTier = false,
  saveHighTierField,
  raiseFieldToHighTier,
  saveLowTierField,
  updateLowTierField,
}: IdentityViewProps) {
  const lowGroups = groupLowTier(lowTierFields);
  const highGroups = groupHighTier(highTierFields);
  return (
    <>
      <WorkspaceHeading
        title="About you"
        description="Everyday details your agents can use, and protected details they have to ask you for each time."
      />

      {/* ----- Everyday details: editable in place, by purpose ----- */}
      <WorkspacePanel
        title="Everyday details"
        description="Your name, contact details and preferences. Agents you allow can read these without asking."
      >
        <div className="flex flex-col gap-4">
          {lowGroups.length === 0 ? (
            <EmptyState
              variant="inline"
              icon={UserRound}
              heading="No everyday details yet."
              description="Add your name, email, phone or postal address so your agents can use them."
            />
          ) : (
            lowGroups.map((group) => (
              <ListGroup key={group.id} id={`vault-${group.id}`} title={group.title} count={group.fields.length} level={3}>
                {group.fields.map((field) => (
                  <LowTierRow
                    key={field.id}
                    field={field}
                    raiseFieldToHighTier={raiseFieldToHighTier}
                    updateLowTierField={updateLowTierField}
                  />
                ))}
              </ListGroup>
            ))
          )}
          <div className="border-t border-line pt-4">
            <LowTierDetailFlow mode="add" saveLowTierField={saveLowTierField} />
          </div>
        </div>
      </WorkspacePanel>

      {/* ----- Protected details: encrypted on the device, by kind ----- */}
      <WorkspacePanel
        title="Protected details"
        description="Things like your passport, licence or date of birth. They're encrypted on this device before they're saved, and an agent has to ask you each time."
      >
        <div className="flex flex-col gap-4">
          {highGroups.length === 0 ? (
            <EmptyState
              variant="inline"
              icon={ShieldCheck}
              heading="No protected details yet."
              description="Add one when an agent will need it for you, like a passport number for a booking."
            />
          ) : (
            highGroups.map((group) => (
              <ListGroup key={group.id} id={`vault-protected-${group.id}`} title={group.title} count={group.fields.length} level={3}>
                {group.fields.map((field) => (
                  <HighTierRow key={field.id} field={field} />
                ))}
              </ListGroup>
            ))
          )}
          {/* The live on-device add flow: closed it is the "Add a protected detail"
              control, open it seals the value under the vault key and submits only
              ciphertext + metadata. */}
          <div className="border-t border-line pt-4">
            <HighTierFlow mode="add" saveHighTierField={saveHighTierField} initialOpen={addingHighTier} />
          </div>
        </div>
      </WorkspacePanel>
    </>
  );
}

export default IdentityView;
