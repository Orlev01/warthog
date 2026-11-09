import * as React from "react";
import { Wordmark } from "../shell/wordmark";
import { OPERATOR_NAME, SUPPORT_EMAIL } from "./operator";

export function Terms() {
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
    <header className="flex flex-col gap-6"><Wordmark href="/" /><h1 className="text-3xl font-semibold text-fg">Terms of use</h1></header>
    <section className="flex flex-col gap-3 text-sm text-fg-muted">
      <h2 className="text-lg font-semibold text-fg">Using Warthog</h2>
      <p>Warthog is operated by {OPERATOR_NAME}. It helps you connect services, set rules for your agents, and review requests to use your information. These terms describe your use of Warthog and its optional messaging service.</p>
      <p>Use only accounts, phone numbers and information you own or are authorized to manage. Keep your sign-in and vault recovery methods secure. Do not use Warthog for unlawful activity, unsolicited messaging, impersonation or attempts to bypass another person&apos;s access controls.</p>
      <p>Review a request before approving it. An agent or connected service may retain or use information you release under its own terms. Disconnecting it prevents future access through Warthog but does not recall information already handed over. Warthog is not an emergency service; do not depend on a notification arriving for an urgent or safety-critical decision.</p>
    </section>
    <section className="flex flex-col gap-3 text-sm text-fg-muted">
      <h2 className="text-lg font-semibold text-fg">Optional Warthog SMS</h2>
      <p>Requesting a verification code authorizes one verification text. Approval alerts require a separate choice in notification settings. Message frequency varies with your requests and approvals. Message and data rates may apply under your mobile plan. SMS consent is not a condition of using Warthog or making a purchase.</p>
      <p>Reply STOP to stop texts, or HELP for help. To resume after STOP, reply START to the sender and enable approval alerts in Warthog if you want them. HELP does not restore consent. You can turn approval alerts off in settings and save; this does not block a later verification text you explicitly request, though a carrier or provider opt-out may still block delivery.</p>
      <p>SMS is available only in enabled destinations and on supported networks. International number formatting does not guarantee coverage. Country registration, network restrictions and opt-out settings can prevent delivery. Messages may be delayed or lost; Warthog and mobile carriers cannot guarantee their arrival. Check requests in the app when a notification does not arrive.</p>
    </section>
    <section className="flex flex-col gap-3 text-sm text-fg-muted">
      <h2 className="text-lg font-semibold text-fg">Privacy, availability and help</h2>
      <p>Our <a className="underline" href="/privacy">Privacy policy</a> explains data handling, overseas messaging providers, account export and deletion. Google, Microsoft, email, SMS and push services have their own availability and account restrictions. Features and supported destinations can change; these terms do not promise worldwide messaging or uninterrupted service.</p>
      <p>You can stop using Warthog, disconnect services or request account deletion in settings. Contact <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> for support, privacy requests or concerns about these terms. Nothing in these terms excludes rights that applicable law does not allow us to exclude.</p>
    </section>
  </main>;
}
