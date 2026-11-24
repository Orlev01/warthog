"use client";

import * as React from "react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { LIST_ROW } from "@/components/ui/list-group";
import { PROFILE_SOURCE_CONNECTORS } from "@/domain/life-admin/profile-sources";
import { LOW_TIER_KIND_LABELS } from "./low-tier-detail-flow";

// About you suggestions (docs/adr/profile-build.md): the everyday details an agent found and
// suggested, waiting for the person to say which are right. IdentityView shows this panel above
// the everyday details whenever something is waiting; with nothing waiting it isn't shown.
//
// Each suggestion is its own row, confirmed on its own (there is no "Add all"): the kind, the
// value (an address with the date they're moving there), where the agent says it found it in
// plain words, and a mark when it differs from the detail of that kind they already have. Add
// and Not mine are plain forms that post the suggestion's id to the page's server actions, so
// they work before the page's JavaScript has loaded. Add is a secondary action: the page's one
// primary is "Add a detail". Agents never see a suggestion until it's added.
//
// Colour comes from the design tokens (globals.css), never a raw hex.

// The kinds an agent may suggest (the store's IDENTITY_SUGGESTION_KINDS), declared here so this
// client view never couples to the server db modules.
export type IdentitySuggestionKind = "preferred_name" | "email" | "phone" | "postal_address" | "language" | "time_zone";

// A waiting suggestion as the page hands it over (the actions' IdentitySuggestionItem).
export type IdentitySuggestionView = {
  id: string;
  kind: IdentitySuggestionKind;
  value: string;
  movingOn: string | null;
  source: { service: string; date?: string; sender?: string };
  agentName: string;
  differsFrom?: boolean;
};

// A plain form's server action: it reads the suggestion's `id` and redirects back with a notice.
export type SuggestionAction = (formData: FormData) => void | Promise<void>;

export type IdentitySuggestionsProps = {
  suggestions: ReadonlyArray<IdentitySuggestionView>;
  acceptSuggestion: SuggestionAction;
  declineSuggestion: SuggestionAction;
};

// The same plain labels the everyday details use.
const KIND_LABELS: Readonly<Record<string, string>> = Object.fromEntries(LOW_TIER_KIND_LABELS);

function kindLabel(kind: IdentitySuggestionKind): string {
  return KIND_LABELS[kind] ?? "Detail";
}

// "3 Oct 2026" for a calendar date, shown as written (never shifted by a time zone); null for
// anything that isn't a real YYYY-MM-DD date.
function calendarDay(day: string | null | undefined): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

type SourceKind = "email" | "calendar" | "file";

// What kind of thing the agent found it in: Warthog's own connector ids first, then the looser
// names an agent might give ("gmail", "Outlook", "calendar"). A calendar is checked before mail,
// so an Outlook calendar is a calendar.
function sourceKind(service: string): SourceKind | null {
  const name = service.trim().toLowerCase();
  const known = PROFILE_SOURCE_CONNECTORS.get(name);
  if (known) return known === "mail" ? "email" : known === "files" ? "file" : "calendar";
  if (/calendar/.test(name)) return "calendar";
  if (/gmail|outlook|e-?mail|\bmail\b/.test(name)) return "email";
  if (/drive|\bfiles?\b/.test(name)) return "file";
  return null;
}

// The domain an email came from, when the sender gives one ("AGL <bills@agl.com.au>" or
// "agl.com.au"); nothing for a bare name, so no one is named on the agent's say-so alone.
const DOMAIN = "[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}";
function senderDomain(sender: string | undefined): string | null {
  if (!sender) return null;
  const address = sender.match(new RegExp(`[^\\s<>@"]+@(${DOMAIN})`, "i"));
  if (address) return address[1]!.toLowerCase();
  const bare = sender.trim().match(new RegExp(`^(${DOMAIN})$`, "i"));
  return bare ? bare[1]!.toLowerCase() : null;
}

/** "Suggested by Claude · from an email from agl.com.au, 3 Oct 2026". */
export function suggestionSourceLine(suggestion: Pick<IdentitySuggestionView, "agentName" | "source">): string {
  const { service, sender, date } = suggestion.source;
  const kind = sourceKind(service);
  let from: string;
  if (kind === "email") {
    const domain = senderDomain(sender);
    from = domain ? `from an email from ${domain}` : "from an email";
  } else if (kind === "calendar") {
    from = "from your calendar";
  } else if (kind === "file") {
    from = "from a file";
  } else {
    from = `from ${service.trim()}`;
  }
  const day = calendarDay(date);
  return `Suggested by ${suggestion.agentName} · ${from}${day ? `, ${day}` : ""}`;
}

function SuggestionRow({
  suggestion,
  acceptSuggestion,
  declineSuggestion,
}: {
  suggestion: IdentitySuggestionView;
  acceptSuggestion: SuggestionAction;
  declineSuggestion: SuggestionAction;
}) {
  const label = kindLabel(suggestion.kind);
  const named = `${label.toLowerCase()} suggestion`;
  const valueId = `about-you-suggestion-${suggestion.id}`;
  const movingOn = suggestion.kind === "postal_address" ? calendarDay(suggestion.movingOn) : null;
  return (
    <li className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm text-fg-muted">{label}</p>
          <p id={valueId} className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">
            {suggestion.value}
            {movingOn ? <span className="font-normal text-fg-muted"> · moving here on {movingOn}</span> : null}
          </p>
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{suggestionSourceLine(suggestion)}</p>
          {suggestion.differsFrom ? (
            <p className="pt-1">
              <Badge tone="info">Different from the one you have</Badge>
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <ActionForm action={acceptSuggestion}>
            <input type="hidden" name="id" value={suggestion.id} />
            <FormSubmit variant="secondary" pendingLabel="Adding…" aria-label={`Add ${named}`} aria-describedby={valueId}>
              Add
            </FormSubmit>
          </ActionForm>
          <ActionForm action={declineSuggestion}>
            <input type="hidden" name="id" value={suggestion.id} />
            <FormSubmit variant="ghost" pendingLabel="Removing…" aria-label={`Not mine: ${named}`} aria-describedby={valueId}>
              Not mine
            </FormSubmit>
          </ActionForm>
        </div>
      </div>
    </li>
  );
}

export function IdentitySuggestions({ suggestions, acceptSuggestion, declineSuggestion }: IdentitySuggestionsProps) {
  if (suggestions.length === 0) return null;
  return (
    <WorkspacePanel
      title="Suggested by your agents"
      description="Your agent found these. Add the ones that are right; nothing is used until you do."
    >
      <ul role="list" className="flex min-w-0 flex-col">
        {suggestions.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            suggestion={suggestion}
            acceptSuggestion={acceptSuggestion}
            declineSuggestion={declineSuggestion}
          />
        ))}
      </ul>
    </WorkspacePanel>
  );
}

export default IdentitySuggestions;
