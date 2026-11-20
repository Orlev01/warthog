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

It costs nothing: LinkedIn's self-serve products are free. LinkedIn allows each member about 150
calls a day through an app. A post uses two (Warthog reads who the member is, then posts), so that
is about 75 posts a day.

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
a laptop. The app's identity can read only the secrets granted to it one by one, so LinkedIn's
needs its own grant. A plain `update` release refuses new settings, so LinkedIn arrives through
its one-time activation release.

Do these in order. Each step depends on the one before.

```
export AZURE_CONFIG_DIR=~/.azure-personal SUB=e854f594-274f-4051-841b-78df7655d73c
VAULT_ID=$(az keyvault show -n kv-warthog-aue-e854 -g rg-warthog-prod-aue --subscription $SUB --query id -o tsv)
```

1. **Write the secret into Key Vault** from a fresh lease VM that never becomes a runner.
   - Set up `.delivery/linkedin-secret/runner-<lease>/approved.tfvars.json` as for a release.
     Any 10–14 digit lease id that no release will use works, for example today's date and time.
   - Run `runner.py plan --directory <dir>`, review it with `review-runner-plan.py`, then
     `runner.py apply --directory <dir> --reviewed-plan-sha256 <sha>`.
   - Don't run `prepare` or `register`.
   - Run:

     ```
     python3 scripts/delivery/runner.py install-secret --directory <dir> \
       --secret LINKEDIN_CLIENT_SECRET --value-file ~/.warthog/linkedin-client-secret
     ```

   - **What it does:**
     - It refuses a VM that has run anything but `prepare`, or that was registered.
     - It refuses a secret file that others can read, or one inside the repository.
     - It sends the value only as a protected Run Command parameter.
     - It runs the setup installer, which never rotates an existing secret silently.
   - **What it keeps:** only the versioned secret URL, in `<dir>/secret-url.txt`.
   - Then run `runner.py destroy --directory <dir>` and the release scripts' cleanup check
     (`verify-cleanup.py <lease>`). `register` refuses this VM for good.
   - Delete `~/.warthog/linkedin-client-secret`.
2. **Let the app read it.** `infra/main.tf` grants the app identity "Key Vault Secrets User" on
   `linkedin-client-secret` only when the foundation variable `linkedin_secret_installed` is true.
   It is false by default, so foundation runs keep working before the secret exists.
   - Add `"linkedin_secret_installed": true` to the `FOUNDATION_TFVARS_JSON` repository secret
     (the founder edits it in GitHub → Settings → Secrets, or `gh secret set FOUNDATION_TFVARS_JSON`
     from a file that is then deleted).
   - Run a foundation plan, review it (one new role assignment and nothing else), and have the
     founder approve the apply, as for any foundation change.
   - It must come after step 1: a grant can't be scoped to a secret that doesn't exist yet.
   - **One-off alternative.** If a foundation run isn't practical, run this:

     ```
     PRINCIPAL=$(az identity show -n id-warthog-app-aue -g rg-warthog-prod-aue --subscription $SUB --query principalId -o tsv)
     az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
       --role "Key Vault Secrets User" --scope "$VAULT_ID/secrets/linkedin-client-secret" --subscription $SUB
     ```

     While `linkedin_secret_installed` stays false, foundation runs leave this assignment alone.
     Before setting it true, import the assignment into the foundation state (or delete it), or the
     apply fails on "already exists". Record it in the release record.
   - **Check either way.** This must list exactly one assignment:

     ```
     az role assignment list --scope "$VAULT_ID/secrets/linkedin-client-secret" \
       --role "Key Vault Secrets User" --subscription $SUB --query "[].principalId" -o tsv
     ```

     It must show the app identity's principal id. The release job can't check this itself.
3. **Reference it from the app.** This adds an app secret and creates no revision:

   ```
   IDENTITY=$(az containerapp show -n warthog -g rg-warthog-prod-aue --subscription $SUB \
     --query "properties.configuration.secrets[?name=='database-url'].identity | [0]" -o tsv)
   az containerapp secret set -n warthog -g rg-warthog-prod-aue --subscription $SUB \
     --secrets "linkedin-client-secret=keyvaultref:$(cat <dir>/secret-url.txt),identityref:$IDENTITY"
   ```

   The activation release refuses a reference that isn't a pinned version of
   `linkedin-client-secret` in the app's own vault, read with the app's identity. It refuses before
   maintenance stops production.
4. **Snapshot the configuration again.** Step 3 changed the fingerprint, so take `live-before.json`
   and `expected_config_sha256` after it.
5. **Release.** Follow the usual recipe, adding `-f activate_linkedin=true -f linkedin_client_id=<Client ID>` to
   the `azure-release.yml` dispatch. It can ride with any image release. The release adds exactly
   `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET=secretref:linkedin-client-secret`, and refuses
   if anything else changed.
6. **Check it.**
   - Connectors shows LinkedIn under Social.
   - Connect the founder's LinkedIn: the account shows their email, or their name if LinkedIn gives
     no email.
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
