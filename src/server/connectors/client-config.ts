import type { Config } from "../config";
import type { OAuthClientConfig } from "./oauth-client";
import { connectCallbackUrl } from "../http/routes";
import { HttpError } from "../http/validate";
import type { CatalogueEntry } from "../../domain/catalogue/schema";

export function providerFor(id: string): "google" | "microsoft" | undefined {
  if (["google-gmail", "google-calendar", "google-drive"].includes(id)) return "google";
  if (["microsoft-outlook-mail", "microsoft-outlook-calendar", "microsoft-onedrive"].includes(id)) return "microsoft";
  return undefined;
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
  return { clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: connectCallbackUrl(config.publicBaseUrl) };
}
export function withIdentityScope(entry: CatalogueEntry): CatalogueEntry {
  const provider = providerFor(entry.id);
  if (!provider) return entry;
  const identityScope = provider === "google" ? "https://www.googleapis.com/auth/userinfo.email" : "https://graph.microsoft.com/User.Read";
  return { ...entry, auth: { ...entry.auth, scopes: [...new Set([...(entry.auth.scopes ?? []), identityScope])] } };
}
