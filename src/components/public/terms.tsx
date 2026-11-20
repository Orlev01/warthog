import * as React from "react";

import { RELATIVE_LINKS, type PublicLinks } from "@/server/http/public-links";
import { PublicPage, PublicPanel, PublicSection } from "./public-page";
import { LAST_UPDATED, OPERATOR_NAME, SUPPORT_EMAIL } from "./operator";

// Terms — the public terms of use, inside the shared public document frame (PublicPage).
// Australian spelling throughout; deletion is described the same way as on the privacy page.
export function Terms({ links = RELATIVE_LINKS }: { links?: PublicLinks } = {}) {
  return (
    <PublicPage links={links} title="Terms of use" current="terms" meta={`Last updated ${LAST_UPDATED}`}>
      <PublicPanel>
        <PublicSection id="using-warthog" title="Using Warthog">
          <p>Warthog is operated by {OPERATOR_NAME}. It helps you connect services, set rules for your agents, and review requests to use your information. These terms describe your use of Warthog and its optional messaging service.</p>
          <p>Use only accounts, phone numbers and information you own or are authorised to manage. Keep your sign-in and vault recovery methods secure. Do not use Warthog for unlawful activity, unsolicited messaging, impersonation or attempts to bypass another person&apos;s access controls.</p>
          <p>Review a request before approving it. An agent or connected service may retain or use information you release under its own terms. Disconnecting it prevents future access through Warthog but does not recall information already handed over. Warthog is not an emergency service; do not depend on a notification arriving for an urgent or safety-critical decision.</p>
        </PublicSection>
        <PublicSection id="sms" title="Optional Warthog SMS">
          <p>Requesting a verification code authorises one verification text. Approval alerts require a separate choice in notification settings. Message frequency varies with your requests and approvals. Message and data rates may apply under your mobile plan. SMS consent is not a condition of using Warthog or making a purchase.</p>
          <p>Reply STOP to stop texts, or HELP for help. To resume after STOP, reply START to the sender and enable approval alerts in Warthog if you want them. HELP does not restore consent. You can turn approval alerts off in settings and save; this does not block a later verification text you explicitly request, though a carrier or provider opt-out may still block delivery.</p>
          <p>SMS is available only in enabled destinations and on supported networks. International number formatting does not guarantee coverage. Country registration, network restrictions and opt-out settings can prevent delivery. Messages may be delayed or lost; Warthog and mobile carriers cannot guarantee their arrival. Check requests in the app when a notification does not arrive.</p>
        </PublicSection>
        <PublicSection id="privacy-availability" title="Privacy, availability and help">
          <p>Our <a href="/privacy">Privacy policy</a> explains data handling, overseas messaging providers, account export and deletion. Google, Microsoft, email, SMS and push services have their own availability and account restrictions. Features and supported destinations can change; these terms do not promise worldwide messaging or uninterrupted service.</p>
          <p>You can stop using Warthog, disconnect services or delete your account yourself in Settings. Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, or use <a href={`${links.account}/contact`}>Contact us</a> in the app, for support, privacy requests or concerns about these terms. Nothing in these terms excludes rights that applicable law does not allow us to exclude.</p>
        </PublicSection>
      </PublicPanel>
    </PublicPage>
  );
}
