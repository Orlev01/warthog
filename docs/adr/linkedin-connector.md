# LinkedIn connector

Decision date: 20 November 2026.

The founder asked Warthog to "look into connecting LinkedIn", then to "set up LinkedIn as much as you
can without me". This records what LinkedIn lets an app do, what Warthog built, and what the founder
still has to do (docs/linkedin-launch.md).

## What LinkedIn allows

LinkedIn has no official MCP server and no automatic client registration, so, as with Google and
Microsoft, Warthog uses its own LinkedIn app, which the founder registers.

Without LinkedIn's approval, an app can use two self-serve products:

- **Sign In with LinkedIn using OpenID Connect** (`openid profile email`): the member's name, email,
  photo and a member id.
- **Share on LinkedIn** (`w_member_social`): create and delete posts as the member.

LinkedIn's partner programmes are for approved businesses (Community Management, Marketing, Sales,
Talent). Everything else needs one of them: reading the member's feed or their own posts
(`r_member_social` is restricted), connections, messages, sending messages, and profile details
(job history, skills). The EU's data-portability API covers EU members only. Warthog therefore
offers only what the two self-serve products give. Unofficial tools that scrape LinkedIn break its
terms and get accounts restricted, so Warthog doesn't use them.

## Decision

**Three curated tools** (`src/server/connectors/curated/linkedin.ts`):

- `linkedin__profile` reads the member's name, email, email-verified flag and photo from
  `GET /v2/userinfo`.
- `linkedin__create_post` makes a change. Warthog builds the post from plain fields:
  - `text`: up to LinkedIn's 3,000 characters;
  - `visibility`: `CONNECTIONS` by default, or `PUBLIC`;
  - an optional `link {url, title?, description?}`, shown as an article, titled with the site's
    name when no title is given.
  - Only a public https link is accepted. No @mentions; hashtags work.
  - The text goes through `stripInvisible`.
  - LinkedIn reads post text as "little" text, where `\ | { } @ [ ] ( ) < > # * _ ~` are markup.
    Unescaped, they can cut the rest of a post off, so each is escaped except the `#` of a hashtag
    (`src/domain/content/linkedin-post.ts`).
  - The member id comes from `/v2/userinfo` at post time, so nothing extra is stored.
  - The post goes to the Posts API, `POST /rest/posts`, with `LinkedIn-Version: 202611` (one
    constant, `LINKEDIN_VERSION`) and `X-Restli-Protocol-Version: 2.0.0`. LinkedIn supports a
    version for about a year, so move it forward before November 2027.
  - LinkedIn names the new post in the `x-restli-id` header (`urn:li:share:…`). The result is
    `{id, url, visibility}`, where `url` is `https://www.linkedin.com/feed/update/<id>/`.
- `linkedin__delete_post` makes a change: `DELETE /rest/posts/<encoded id>`. It accepts only a
  share or ugcPost id.

**A post always asks first.** LinkedIn's terms restrict automated posting on a member's behalf, and
a post goes to everyone the member knows. So `create_post` asks the person even when the agent is
allowed to make changes alone.

- The connector declaration's new `alwaysAsk` flag rides on the call to the policy engine
  (`PolicyCall.alwaysAsk`).
- `evaluate` step 6 then asks, with the reason "Posts always need your approval first.":
  - after a matching ask-first rule, so the person's own rule keeps its id on the card;
  - before the tool-class default.
- A denial, a tool that's switched off and a never-allow rule still refuse it. Approving the ask
  lets it run once, as for every other ask.
- This is not `requiresApproval`. That flag is for provider-hosted tools whose effect Warthog can't
  verify, and it widens rules to "any change". A post's effect is known, so rules match it as
  written:
  - it carries `messageChannel: "post"`, so a person's "never post" or "ask before posting" rule
    applies;
  - an email rule doesn't.
- It is `outbound` (and always so), for the recently-read check.

**The approval card shows the post** (approval-card truth, docs/adr/approval-card-truth.md). It is
built from the same input the post is built from:

- the sentence: "Claude wants to post on LinkedIn for anyone to see", or "… for your connections to
  see";
- up front: the post's opening words, and the link's site;
- in Details: the full post, the full link, and why the person is asked.

**Undo deletes the post.** `create_post` declares `delete_post` as its reversal. The reversal target
keeps only LinkedIn's post id, checked against the share/ugcPost pattern, under the stored
`eventId` key that calendar entries already use. The delete is called with `query.id`
(`src/server/activity/calendar-reversal.ts`).

**Signing in to LinkedIn:**

- LinkedIn's web sign-in authenticates with the client secret (`client_secret_post`) and `state`. It
  offers PKCE only to native apps it has enabled for it, so Warthog sends no PKCE challenge to
  LinkedIn. Auth.js's LinkedIn provider does the same (`checks: ["state"]`).
  `OAuthClientConfig.pkce: false` is set for LinkedIn only.
- LinkedIn's ID token issuer is `https://www.linkedin.com/oauth`.
- The account is named by the email from `/v2/userinfo`, so reconnecting the same account renews the
  same connection (docs/adr/google-published-and-accounts.md).
- **60 days, then reconnect.** LinkedIn gives apps outside its partner programmes no refresh token.
  - Connecting schedules the usual `connection.refresh` job, due at expiry.
  - When it runs, there is nothing to renew with, so the connection goes to "Reconnect needed" and
    the person gets the usual push.
  - The `connector.refresh` metric records this as `lapsed`, not `failed`.
- **Disconnecting.** LinkedIn documents no revoke call for apps outside its partner programmes.
  An undocumented `POST https://www.linkedin.com/oauth/v2/revoke` appears to exist (it answers
  with an OAuth-style error), but Warthog doesn't rely on it.
  - Disconnecting removes Warthog's stored credentials, so Warthog can no longer use the access.
  - The token itself stays valid at LinkedIn until it expires, at most 60 days later.
  - The disconnect notice tells the person where to remove Warthog: Settings › Data privacy ›
    Permitted services.
  - If LinkedIn documents the revoke call, add it to the runtime's `revoke` beside Google's.

**It ships dark.**

- `catalogue/connectors/linkedin.json` is an `oauth2` entry, in a new "Social" catalogue group.
- An `oauth2` entry is connectable only when its client is configured, and the Connectors page
  shows only what a person can connect. So nobody sees LinkedIn until `LINKEDIN_CLIENT_ID` and
  `LINKEDIN_CLIENT_SECRET` are both set.
- Production readiness accepts both or neither.
- The Rules page lists every catalogue service by name, as it already does for any unconfigured
  entry, so LinkedIn appears there as a rule target.

**Production wiring.** A plain `update` release copies the live revision and refuses any other
configuration change. So LinkedIn arrives through a one-time activation, like the deletion
journal's (`scripts/ci/deploy_app.py`):

- The `azure-release.yml` inputs are `activate_linkedin` and `linkedin_client_id`, which is the
  plain client ID, never the secret.
- The release requires the app secret `linkedin-client-secret` to already exist as a Key Vault
  reference.
- It adds exactly `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET=secretref:linkedin-client-secret`
  and checks that nothing else changed.
- The Key Vault secret itself goes in through the existing private installer
  (`scripts/delivery/install-secrets.py`, which now knows `LINKEDIN_CLIENT_SECRET`), because the
  vault accepts only the app and bootstrap subnets.
- Adding the app secret changes the live configuration's fingerprint, so the activation release
  takes a fresh snapshot after it.
- The workload template for a first `create` is unchanged. A fresh creation would need the
  activation release afterwards.

**Privacy page.** A new section, "Your connected LinkedIn account", says what Warthog reads, that
every post waits for approval, what it can't see, the 60 days, and how to remove access.

## Not done

- Images and documents in posts. They need LinkedIn's Images API upload, and a way to take an image
  from an agent safely.
- A reminder a few days before the 60 days run out. Today the person learns at the lapse.
- Posting as a Company Page. That needs `w_organization_social`, from the Community Management API,
  which is a partner product.
- Reading the member's posts, comments and reactions, which needs `r_member_social`.
