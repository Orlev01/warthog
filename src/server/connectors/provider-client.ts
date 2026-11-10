import {
  Client,
  StreamableHTTPClientTransport,
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthTokens,
  type StoredOAuthClientInformation,
  type Tool,
} from "@modelcontextprotocol/client";
import { createGuardedFetch } from "../http/guarded-fetch";

// Stored inside the owner's encrypted connection credentials. The verifier and
// discovery state are also retained together across the browser redirect.
export interface ProviderState {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  tools?: Tool[];
}
interface Settings {
  serverUrl: string;
  publicBaseUrl: string;
  state?: string;
}
const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 15_000;

/** Socket-time DNS checks, HTTPS, caller cancellation, byte and time bounds.
 * Unlike the JSON discovery fetch, this returns SSE chunks without buffering
 * until EOF (a provider may keep the stream open after sending a response). */
export function createGuardedMcpFetch(
  inner = createGuardedFetch(),
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid provider URL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    try {
      const response = await inner(request, { signal, redirect: "error" });
      if (response.status >= 300 && response.status < 400)
        throw new Error("Provider redirects are not accepted");
      if (Number(response.headers.get("content-length")) > MAX_BYTES)
        throw new Error("Provider response too large");
      if (!response.body) {
        clearTimeout(timer);
        return response;
      }
      const reader = response.body.getReader();
      let total = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              clearTimeout(timer);
              target.close();
              return;
            }
            total += value.byteLength;
            if (total > MAX_BYTES)
              throw new Error("Provider response too large");
            target.enqueue(value);
          } catch (error) {
            clearTimeout(timer);
            controller.abort();
            await reader.cancel().catch(() => {});
            target.error(error);
          }
        },
        async cancel() {
          clearTimeout(timer);
          controller.abort();
          await reader.cancel().catch(() => {});
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      clearTimeout(timer);
      controller.abort();
      throw error;
    }
  }) as typeof fetch;
}

function oauthProvider(
  settings: Settings,
  state: ProviderState,
  save: () => Promise<void>,
  redirect?: (url: URL) => void,
): OAuthClientProvider {
  const callback = new URL("/connect/callback", settings.publicBaseUrl).href;
  return {
    redirectUrl: callback,
    clientMetadataUrl: new URL(
      "/oauth/client-metadata.json",
      settings.publicBaseUrl,
    ).href,
    clientMetadata: {
      client_name: "Warthog",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: () => settings.state ?? "",
    clientInformation: () => state.client,
    saveClientInformation: async (info) => {
      state.client = info;
      await save();
    },
    tokens: () => state.tokens,
    saveTokens: async (tokens) => {
      state.tokens = tokens;
      await save();
    },
    redirectToAuthorization: (url) => {
      if (!redirect) throw new Error("Reconnect this service in Warthog");
      redirect(url);
    },
    saveCodeVerifier: async (verifier) => {
      state.verifier = verifier;
      await save();
    },
    codeVerifier: () => {
      if (!state.verifier) throw new Error("Expired provider sign-in");
      return state.verifier;
    },
    discoveryState: () => state.discovery,
    saveDiscoveryState: async (value) => {
      state.discovery = value;
      await save();
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "client") delete state.client;
      if (scope === "all" || scope === "tokens") delete state.tokens;
      if (scope === "all" || scope === "verifier") delete state.verifier;
      if (scope === "all" || scope === "discovery") delete state.discovery;
      await save();
    },
  };
}

export async function startProviderAuthorization(
  settings: Settings,
  state: ProviderState,
  request: typeof fetch,
): Promise<string> {
  let target: string | undefined;
  const provider = oauthProvider(
    settings,
    state,
    async () => {},
    (url) => {
      target = url.href;
    },
  );
  const result = await auth(provider, {
    serverUrl: settings.serverUrl,
    fetchFn: request,
  });
  if (result !== "REDIRECT" || !target)
    throw new Error("Provider did not start sign-in");
  const url = new URL(target);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid provider sign-in URL");
  return target;
}

export async function finishProviderAuthorization(
  settings: Settings & { code: string; iss?: string },
  state: ProviderState,
  request: typeof fetch,
): Promise<void> {
  const provider = oauthProvider(settings, state, async () => {});
  const result = await auth(provider, {
    serverUrl: settings.serverUrl,
    authorizationCode: settings.code,
    iss: settings.iss,
    fetchFn: request,
  });
  if (result !== "AUTHORIZED" || !state.tokens)
    throw new Error("Provider authorization failed");
  delete state.verifier;
}

export async function useProviderClient<T>(
  settings: Settings,
  state: ProviderState,
  request: typeof fetch,
  save: () => Promise<void>,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(
    new URL(settings.serverUrl),
    {
      authProvider: oauthProvider(settings, state, save),
      fetch: request,
      requestInit: { redirect: "error" },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    },
  );
  const client = new Client(
    { name: "Warthog", version: "1" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function discoverProviderTools(
  settings: Settings,
  state: ProviderState,
  request: typeof fetch,
  save: () => Promise<void>,
): Promise<Tool[]> {
  return useProviderClient(settings, state, request, save, async (client) => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    let bytes = 0;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: TIMEOUT_MS,
      });
      for (const tool of page.tools) {
        if (
          !/^[a-zA-Z0-9_.-]{1,100}$/.test(tool.name) ||
          seen.has(tool.name) ||
          JSON.stringify(tool).length > 32_000
        )
          throw new Error("Unsupported provider tool declaration");
        bytes += Buffer.byteLength(JSON.stringify(tool));
        if (bytes > MAX_BYTES)
          throw new Error("Provider tool descriptions are too large");
        tools.push(tool);
        seen.add(tool.name);
      }
      if (tools.length > 200) throw new Error("Provider has too many tools");
      cursor = page.nextCursor;
      if (cursor && page.tools.length === 0)
        throw new Error("Invalid provider pagination");
    } while (cursor);
    return tools;
  });
}
