import type { Config } from "../config";
import type { OAuthClientConfig } from "./oauth-client";
import { connectCallbackUrl } from "../http/routes";
import { HttpError } from "../http/validate";
import type { CatalogueEntry } from "../../domain/catalogue/schema";

export type SignInProvider = "google" | "microsoft" | "linkedin";

export function providerFor(id: string): SignInProvider | undefined {
  if (["google-gmail", "google-calendar", "google-drive"].includes(id)) return "google";
  if (["microsoft-outlook-mail", "microsoft-outlook-calendar", "microsoft-onedrive"].includes(id)) return "microsoft";
  if (id === "linkedin") return "linkedin";
  return undefined;
}
// LinkedIn gives apps outside its partner programmes no refresh token: its access lasts 60 days
// and then the person reconnects (docs/adr/linkedin-connector.md).
export function renewable(provider: SignInProvider | undefined): boolean {
  return provider !== "linkedin";
}
export function oauthClientConfigured(config: Config, id: string): boolean {
  const provider = providerFor(id);
  const client = provider && config.connectorClients?.[provider];
  return !!(client && client.clientId && client.clientSecret);
}
export function oauthClientFor(config: Config, id: string): OAuthClientConfig {
  const provider = providerFor(id);
  const client = provider && config.connectorClients?.[provider];
  if (!client || !client.clientId || !client.clientSecret) throw new HttpError(503, "This service is not configured yet.");
  // LinkedIn's web sign-in authenticates with the client secret and state; it offers PKCE only
  // to native apps it has enabled for it.
  return { clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: connectCallbackUrl(config.publicBaseUrl), ...(provider === "linkedin" ? { pkce: false } : {}) };
}
export function withIdentityScope(entry: CatalogueEntry): CatalogueEntry {
  const provider = providerFor(entry.id);
  // LinkedIn's entry already asks for its sign-in profile (openid, profile, email).
  if (!provider || provider === "linkedin") return entry;
  const identityScope = provider === "google" ? "https://www.googleapis.com/auth/userinfo.email" : "https://graph.microsoft.com/User.Read";
  return { ...entry, auth: { ...entry.auth, scopes: [...new Set([...(entry.auth.scopes ?? []), identityScope])] } };
}
