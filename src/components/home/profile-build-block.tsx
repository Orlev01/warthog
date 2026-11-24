"use client";

// Home's "Build your profile" block (docs/adr/profile-build.md; founder, 24 Nov 2026), where the
// set-up step's row leads. The person copies one fixed prompt into their own agent; the agent goes
// through what it can read through Warthog and saves what it finds for them to check. Warthog
// never reads anything itself. The block says what's missing when an agent can't do it yet, and
// what waits for the person afterwards. Nothing about the vault or cards is promised: no agent can
// fill those.
//
// Copy follows the brief's design_ux rules: plain Australian English, no jargon, one primary
// action (Copy for <agent>, or the fix for what's missing).

import * as React from "react";
import { ArrowRight } from "lucide-react";

import { ButtonLink } from "@/components/ui/button-link";
import { CopyButton } from "@/components/ui/copy-button";
import { BUILD_PROFILE_ANCHOR } from "@/domain/home/checklist";
import type { ProfileBuildView } from "@/domain/home/profile-build";
import { PROFILE_PROMPT } from "@/domain/life-admin/profile-skill";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function ProfileBuildBlock({ view }: { view: ProfileBuildView }): React.ReactElement | null {
  const headingId = React.useId();
  if (view.state === "no_agent") return null;
  let heading: string;
  let body: React.ReactNode;
  switch (view.state) {
    case "no_records":
      heading = `${view.agentName} can't save to your Life admin yet`;
      body = (
        <>
          <p className="max-w-prose text-sm leading-relaxed text-fg">
            Let {view.agentName} use your life-admin records, and it can build your profile from what it can read.
          </p>
          <ButtonLink href={view.agentHref} variant="primary">
            Let {view.agentName} use Life admin
            <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
          </ButtonLink>
        </>
      );
      break;
    case "no_sources":
      heading = `${view.agentName} can't read anything yet`;
      body = (
        <>
          <p className="max-w-prose text-sm leading-relaxed text-fg">
            Let {view.agentName} read your email, calendar or files through Warthog, and it can build your profile for you.
          </p>
          <ButtonLink href={view.agentHref} variant="primary">
            Choose what {view.agentName} can read
            <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
          </ButtonLink>
        </>
      );
      break;
    case "waiting": {
      const total = view.records + view.aboutYou;
      heading = `Your agent found ${plural(total, "thing", "things")} for you to check`;
      body = (
        <>
          <p className="max-w-prose text-sm leading-relaxed text-fg">
            Check them so your agents know they're right. Nothing your agent found is used until you do.
          </p>
          <div className="flex flex-wrap gap-2">
            {view.records > 0 ? (
              <ButtonLink href="/life-admin" variant="primary">
                Check {plural(view.records, "record", "records")} in Life admin
              </ButtonLink>
            ) : null}
            {view.aboutYou > 0 ? (
              <ButtonLink href="/vault" variant={view.records > 0 ? "secondary" : "primary"}>
                Check {plural(view.aboutYou, "detail", "details")} in About you
              </ButtonLink>
            ) : null}
          </div>
        </>
      );
      break;
    }
    case "ready":
      heading = `Let ${view.agentName} build your profile`;
      body = (
        <>
          <p className="max-w-prose text-sm leading-relaxed text-fg">
            Paste this into a new conversation with {view.agentName}. It goes through what it can read, saves what it
            finds to your Life admin and suggests your details for About you, all for you to check.
          </p>
          <p className="text-sm text-fg-muted">
            {view.agentName} can read: {listWords(view.sources)}. It can't fill in your vault or cards; you add those yourself.
          </p>
          <div className="flex min-w-0 flex-col gap-3 rounded-[var(--wh-radius-inset)] bg-surface-muted p-4 sm:flex-row sm:items-start">
            <p className="min-w-0 flex-1 whitespace-pre-line text-sm text-fg [overflow-wrap:anywhere]">{PROFILE_PROMPT}</p>
            <CopyButton value={PROFILE_PROMPT} variant="primary" text={`Copy for ${view.agentName}`} label="the prompt to build your profile" />
          </div>
        </>
      );
      break;
  }
  return (
    <section id={BUILD_PROFILE_ANCHOR} aria-labelledby={headingId} className="flex min-w-0 scroll-mt-32 flex-col items-start gap-3">
      <h3 id={headingId} className="wh-group-title">
        {heading}
      </h3>
      {body}
    </section>
  );
}

export default ProfileBuildBlock;
