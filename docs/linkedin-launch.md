# Turning on LinkedIn

Warthog's LinkedIn connector is built and ships switched off (docs/adr/linkedin-connector.md). It
appears in the Connectors page only once Warthog has its own LinkedIn app. Only the founder can
make that app, because it must belong to a LinkedIn Company Page the founder runs. The rest is the
release operator's.

What people get:
- their LinkedIn name, email and photo;
- posts that Claude drafts, which they approve on a card showing the exact text;
- Undo, which deletes the post.

Warthog can't read their feed, connections or messages. LinkedIn asks them to reconnect every
60 days.

It costs nothing: LinkedIn's self-serve products are free. LinkedIn allows each member 150 posts
a day through apps.

## 1. The founder (about 10 minutes, in a browser signed in to LinkedIn)

LinkedIn moves its portal around now and then, so a button may read slightly differently.

1. **A Company Page.** Use a LinkedIn Page you are a super admin of (for example RPR Technologies
   Pty Ltd). If you have none, create one at <https://www.linkedin.com/company/setup/new/>:
   - Company;
   - name Warthog;
   - website `https://warthog.com.au`;
   - industry Software Development;
   - size 0–1;
   - type Privately held;
   - the Warthog logo.
2. **Create the app** at <https://www.linkedin.com/developers/apps/new>:
   - App name: `Warthog`
   - LinkedIn Page: the Page from step 1
   - Privacy policy URL: `https://warthog.com.au/privacy`
   - App logo: `public/icons/icon-512.png` from the repository (square, 512 px)
   - Tick the legal agreement and choose **Create app**.
3. **Verify the app.** On the app's **Settings** tab, choose **Verify** and then **Generate URL**.
   Open that link while signed in as the Page's super admin, and approve.
4. **Add two products.** On the **Products** tab, choose **Request access** for both of these. Both
   are self-serve and are added at once.
   - **Sign In with LinkedIn using OpenID Connect**
   - **Share on LinkedIn**
5. **Add Warthog's address.** On the **Auth** tab, under **OAuth 2.0 settings** → **Authorized
   redirect URLs for your app**, add exactly:

   ```
   https://app.warthog.com.au/connect/callback
   ```

   The same tab should now list the scopes `openid`, `profile`, `email` and `w_member_social`.
6. **Hand over the two values.**
   - **Client ID:** paste it into the chat. It isn't secret: it appears in every sign-in link.
   - **Client secret:** don't paste it into the chat. On the **Auth** tab, use the copy button next
     to **Primary Client Secret**, then run this in the Claude Code session:

     ```
     ! umask 077; mkdir -p ~/.warthog && pbpaste > ~/.warthog/linkedin-client-secret && pbcopy </dev/null && wc -c < ~/.warthog/linkedin-client-secret
     ```

     It saves the secret to a file only your account can read, clears the clipboard, and prints
     only the secret's length.

## 2. The release operator

The Key Vault accepts only Warthog's app and bootstrap subnets, so the secret can't be written from
a laptop. A plain `update` release refuses new settings, so LinkedIn arrives through its one-time
activation release.

1. **Put the secret in Key Vault**, with the private installer used at setup:
   - Create a runner lease VM in the bootstrap subnet (`scripts/delivery/runner.py` plan, review,
     apply) but **don't register it**.
   - Run `scripts/delivery/install-secrets.py` on it through protected Azure Run Command parameters:
     - `WARTHOG_VAULT_TOKEN`, from `az account get-access-token --resource https://vault.azure.net`;
     - `WARTHOG_SECRET_BUNDLE`, set to `{"LINKEDIN_CLIENT_SECRET": "<the file's contents>"}`, read
       from `~/.warthog/linkedin-client-secret` without printing it.
   - Keep only the versioned secret URL it prints.
   - Then `runner.py destroy` and `verify-cleanup`: a VM that ran a secret command must never become
     a runner.
   - Delete `~/.warthog/linkedin-client-secret`.
2. **Reference it from the app.** This adds an app secret and changes no revision:

   ```
   export AZURE_CONFIG_DIR=~/.azure-personal SUB=e854f594-274f-4051-841b-78df7655d73c
   IDENTITY=$(az containerapp show -n warthog -g rg-warthog-prod-aue --subscription $SUB \
     --query "properties.configuration.secrets[?name=='google-client-secret'].identity | [0]" -o tsv)
   az containerapp secret set -n warthog -g rg-warthog-prod-aue --subscription $SUB \
     --secrets "linkedin-client-secret=keyvaultref:<versioned secret URL>,identityref:$IDENTITY"
   ```
3. **Snapshot the configuration again.** The fingerprint changed in step 2, so take `live-before.json`
   and `expected_config_sha256` after it.
4. **Release.** Follow the usual recipe, adding
   `-f activate_linkedin=true -f linkedin_client_id=<Client ID>` to the `azure-release.yml`
   dispatch. It can ride with any image release. The release adds exactly `LINKEDIN_CLIENT_ID` and
   `LINKEDIN_CLIENT_SECRET=secretref:linkedin-client-secret`, and refuses if anything else
   changed.
5. **Check it.**
   - Connectors shows LinkedIn under Social.
   - Connect the founder's LinkedIn: the account shows their email.
   - Ask Claude to post "Testing Warthog" to connections. The approval card reads "wants to post on
     LinkedIn for your connections to see".
   - Approve it, and the post appears on LinkedIn.
   - Undo it in Activity, and the post is deleted.
   - Write the release record as usual.

## Afterwards

- **Every 60 days** each person's LinkedIn connection shows "Reconnect needed" and they get one
  push. Reconnecting the same account renews it in place.
- **The LinkedIn API version** (`LINKEDIN_VERSION` in `src/server/connectors/curated/linkedin.ts`,
  now `202611`) must move forward before LinkedIn retires it, about a year after release.
- **To turn LinkedIn off**, remove the redirect URL or delete the app in LinkedIn's developer
  portal: new connections fail and existing ones stop working. Taking the two settings back out of
  the live app needs a reviewed configuration change; the release tooling has no switch for that
  yet.
