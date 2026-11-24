# Google published; several accounts of one service

Decision date: 17 November 2026.

The founder has many Gmail accounts and wants them all connected, along with several Outlook and
Notion accounts. Two things stood in the way:

- **Google's Testing mode.** Only listed test users could connect a Google account, and every
  Google connection ended after 7 days. Warthog matched that with its own 7-day clock: a reminder
  push 24 hours before, then "Reconnect needed".
- **Second accounts were rough.**
  - A second account of a service quietly stopped every agent that used the service, until the
    person picked an account for each agent.
  - Reconnecting Google or Microsoft added a second row beside the old one, so agents set to the
    old account were refused.
  - Two Notion workspaces both showed as "Notion".
  - Approval cards didn't say which account a request would use.

## Decision

**Google's side (done by the founder's request, 17 November).**
- The Google app was **published** (In production), without Google's verification.
- Google allows this for a personal-use app with fewer than 100 people.
- The costs:
  - each person sees Google's "Google hasn't verified this app" screen when connecting;
  - at most 100 people can ever connect a Google account, a lifetime cap Google never resets.
- Full verification (a yearly security assessment for the restricted Gmail and Drive permissions)
  waits until Warthog needs more than about 100 people.
- The Google console's Branding page now lists the website, privacy and terms links on
  warthog.com.au, which publishing requires.

**Warthog's side.**
1. **No 7-day clock.** Warthog no longer schedules a reminder or a lapse for Google connections, and
   no longer refuses a renewal after 7 days.
   - A Google connection lasts until Google refuses a renewal, which the refresh job already turns
     into "Reconnect needed" and one notice. That also covers connections made before publishing,
     whose Google grant still ends at 7 days.
   - Reminder and lapse jobs queued before this change finish without doing anything.
2. **The early-access list stays.** It now protects the lifetime cap: someone who isn't on the list
   can't use up one of the 100 places. The connect tile tells an allowlisted person what Google's
   screen will say: "Google will say it hasn't verified Warthog yet. To continue, choose Advanced,
   then Go to warthog.com.au." The brief required this note, but no screen had shown it until now.
3. **The same account renews in place.**
   - When Google or Microsoft returns an account the person already connected to that service
     (the address compared case-insensitively), that connection is updated. Its id stays, and so
     does every agent's choice of it. Connects are serialised per person and service.
   - Connections that need it offer **Reconnect**, which takes the person straight to that
     account (`login_hint`).
   - A new connect shows the provider's account chooser (`prompt=select_account`), so a second
     account is a choice, never whichever account the browser is signed in to.
4. **Adding an account keeps agents where they are.** Just before a second account of a service is
   added, every agent that uses the service with no account chosen is set to the one account it
   uses today. A chosen account is never changed. The [agent-first management](agent-first-management.md)
   rules stand: multiple accounts need a choice, and a chosen account never falls back to another.
5. **Names for other accounts.** A provider-hosted or key-based account can be renamed (Rename on
   its row: up to 60 characters, cleaned of invisible characters). Google and Microsoft accounts
   keep their address, because a reconnect is recognised by it.
6. **Cards say which account.** When the person has more than one account of a service, the
   approval sentence names the account: "wants to send an email to ana@… from work@gmail.com",
   or "(home@gmail.com)" for other requests. With one account nothing changes, and the card stays
   within its three lines. The account is also still under Details.

## Not done (later, if wanted)

- **One agent using several accounts of one service** at once (searching every inbox, or choosing
  the sending address per request). Tools stay one per service, and an agent is set to one account.
- **Disconnecting one of several accounts** still removes the service from agents with no account
  chosen.
- **Rules apply to a whole service**, not to one account.
- **Google verification**, which needs a security assessment each year.

## Consequences

- **Brief changes:** the "Google early access" requirement and the dependency note (Google in its
  published, unverified mode).
- **Design doc change:** technical-design.md §7.
- **No migration**, no new setting, and no new approvals.

Superseded in part (24 Nov 2026) by [one agent, several accounts of a service](several-accounts-per-agent.md):
one agent can now use several accounts of a service, and disconnecting one account leaves the
others granted. Rules still apply to a whole service.
