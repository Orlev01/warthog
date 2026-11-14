import * as React from "react";

import { RELATIVE_LINKS, type PublicLinks } from "@/server/http/website";
import { PublicPage, PublicPanel, PublicSection } from "./public-page";
import { LAST_UPDATED, OPERATOR_NAME, SUPPORT_EMAIL } from "./operator";

// Privacy — the public privacy policy / security-FAQ VIEW (brief feature "Agent
// compatibility and help pages"; data-rights principle 20). From ONE render-testable
// component it makes, in plain Australian English, the plain statement the privacy
// rights constraint requires:
//   • WHAT is stored and WHERE (Australia primary hosting; overseas processors);
//   • that your most sensitive (high-tier) identity details AND your cards are
//     encrypted on your own device, so neither Warthog's servers nor its staff can
//     read them while they are stored;
//   • that those device-protected values pass through Warthog only for the single
//     release you approve, and are discarded once collected or expired; and
//   • HOW to export everything or delete the account.
// The page entry (src/app/privacy/page.tsx) is a thin shell over this component.
//
// Its content is static (no config-driven value is in scope), so — like Landing — it
// takes no props and stays pure (no config, no DB). It renders inside the shared public
// document frame (PublicPage): the reassurances people look for come first (what is stored,
// the device-encrypted details, releases, export and deletion), then the providers that
// process messages and connections (content-34). Colour, spacing and radius come from the
// design tokens — never a raw hex value. The security FAQ may
// use security words like "encryption" (brief design_ux.copy expressly permits them
// here); the rest stays plain Australian English.

export function Privacy({ links = RELATIVE_LINKS }: { links?: PublicLinks } = {}) {
  return (
    <PublicPage
      links={links}
      title="Privacy"
      current="privacy"
      lead="Your privacy and security, in plain words: what we store, where we keep it, who can read it, and how you take it back."
      meta={`Last updated ${LAST_UPDATED}`}
    >
      <PublicPanel>
        <PublicSection id="what-we-store" title="What we store, and where">
          <p>
            Warthog uses Microsoft Azure Australia East as its primary hosting region.
            We keep your identity details, your cards, the activity record of what your
            agents do, your memory and skills, and the rules and budgets you set for
            each agent. Warthog is intended for people around the world. Some data is
            processed outside Australia to provide the services described below.
          </p>
        </PublicSection>

        <PublicSection id="sensitive-details" title="Your most sensitive details are encrypted on your device">
          <p>
            Your most sensitive identity details &mdash; such as your passport or licence
            numbers &mdash; and your cards are encrypted on your own device, with a key
            that stays with you. Warthog only ever stores the encrypted version.
          </p>
          <p>
            That means Warthog&#39;s servers cannot read them, and not even our staff can
            unlock them while they are stored. We show only your card&#39;s brand and last
            four digits, and we never keep a card&#39;s security code at all.
          </p>
        </PublicSection>

        <PublicSection id="releases" title="A release only happens when you approve it">
          <p>
            When an agent needs one of these details or a card, that value passes through
            Warthog once &mdash; only for the single release you approve from inside the
            app &mdash; and is discarded the moment it has been handed over or the request
            expires. It is never kept afterwards.
          </p>
        </PublicSection>

        <PublicSection id="export-delete" title="Export or delete everything, any time">
          <p>
            You can export everything Warthog holds about you whenever you like, and you
            can delete your account yourself, at any time, from your settings. Deletion
            cuts off access and schedules removal from the live application. Provider
            records, delivered messages in your inbox or on your phone, and backups
            follow their own retention schedules; deleting Warthog does not recall
            messages or delete data in your Google or Microsoft account. Application
            database backups may retain older data until their retention period ends.
          </p>
          <p>
            We keep a separate deletion record containing only an account identifier,
            deletion status and timestamps, so recovery from an older backup does not
            restore access to a deleted account. These records are protected from
            deletion for at least 42 days and retained until a reviewed cleanup removes
            expired records. They contain no email address, account content or encryption
            key. Encrypted receipt history can also remain during backup retention.
          </p>
        </PublicSection>

        <PublicSection id="who-handles" title="Who handles your information">
          <p>Warthog is operated by {OPERATOR_NAME}. Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> for privacy questions, access or correction requests, deletion help or complaints. Our <a href="/terms">Terms of use</a> explain the service and optional messaging program.</p>
        </PublicSection>

        <PublicSection id="messaging" title="Email, SMS and overseas processing">
          <p>
            Resend delivers transactional email, such as sign-in codes and security
            notices. It receives your email address and the message, which may contain
            a short-lived code or link. Resend stores email content and delivery logs
            in the United States, regardless of its sending region.
            {" "}Its service providers support hosting, delivery, security and abuse detection;
            see <a href="https://resend.com/legal/subprocessors">Resend&apos;s subprocessor list</a>.
          </p>
          <p>
            When you request a verification text or enable SMS alerts, Twilio validates
            your international phone number and delivers the message through mobile
            carriers. Our SMS integration uses Twilio&apos;s United States region;
            Twilio, its subprocessors and destination carriers may process your number,
            message and delivery information in other countries. SMS is available only
            for enabled destinations and supported networks, not in every country.
            You can turn off SMS alerts in notification settings and use email or
            in-app approvals instead.
          </p>
          <p>
            We do not sell your phone number or SMS consent, or share them with third
            parties for their marketing. Messaging providers receive the information
            needed to deliver the service, prevent abuse and honour opt-outs.
            Requesting a code does not opt you into approval alerts. We record your
            alert preference and when it changes. Reply STOP to stop texts or HELP
            for help; provider suppression is separate from the preference in Warthog.
          </p>
          <p>
            We use encrypted connections to these providers and keep messaging
            credentials on the server. Messages contain only the information needed
            for verification or a notification, not your stored card details, vault
            keys or connected-service credentials. Email and SMS providers can read
            the messages they deliver; they are not end-to-end encrypted.
          </p>
          <p>
            We request message-body redaction for Twilio texts. This is not immediate
            erasure from carriers or restricted compliance records. Phone numbers may
            be retained for delivery, fraud prevention and opt-out suppression. Resend
            normally retains email content and logs for 30 days on its standard plans;
            provider backups and legal obligations can have separate retention periods.
            Turning off SMS stops future alerts but does not erase past messages.
          </p>
        </PublicSection>

        <PublicSection id="connections-push" title="Connections and push notifications">
          <p>
            If you connect Google or Microsoft services, those providers process the
            permissions and data needed for the actions you authorise under their own
            policies and account settings, which may involve other countries. Your
            browser or device provider also processes push delivery information. Our
            push alerts use generic text rather than the details of an approval.
            An agent you authorise, and a device you use outside Australia, may receive
            data overseas when you choose to access or release it.
          </p>
        </PublicSection>

        <PublicSection id="google-microsoft" title="Your connected Google and Microsoft data">
          <p>
            Connecting a service lets Warthog and the agents you authorise access the
            email messages, calendar events or files covered by the permissions you
            grant. We use this access to carry out the requests allowed by your rules
            and approvals. Results are returned to your requesting agent; review that
            agent&apos;s data practices before connecting it. We store encrypted access
            credentials, an account label and activity records so you can manage and
            review the connection. Disconnecting removes Warthog&apos;s stored connection
            credentials; you can also revoke access in your Google or Microsoft account.
          </p>
          <p>
            Warthog does not sell connected Google data, use it for advertising, or
            use it to train general-purpose AI models. Our use and transfer of data
            received through Google APIs must follow the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
            including its Limited Use requirements. This policy does not mean Google
            has verified or endorsed Warthog. Contact our privacy address if you need
            help accessing or deleting connected-service data held by Warthog.
          </p>
        </PublicSection>
      </PublicPanel>
    </PublicPage>
  );
}
