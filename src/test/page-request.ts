// Request-aware page tests use Next's real request stores, not a mock of cookies().
// These test-only internals belong to our pinned Next version; the production build
// and HTTP boot checks also exercise the actual framework composition.
import "next/dist/server/node-environment-baseline.js";
import { NextRequest } from "next/server";
import { createWorkStore } from "next/dist/server/async-storage/work-store.js";
import { createRequestStoreForRender } from "next/dist/server/async-storage/request-store.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";

export function withPageRequest<T>(
  path: string,
  cookie: string | undefined,
  render: () => T,
  headers: Record<string, string> = {},
): T {
  const request = new NextRequest(`https://warthog.example${path}`, {
    headers: cookie ? { ...headers, cookie } : headers,
  });
  const work = createWorkStore({
    page: path,
    buildId: "page-test",
    previouslyRevalidatedTags: [],
    renderOpts: {
      assetPrefix: "",
      supportsDynamicResponse: true,
      experimental: {
        isRoutePPREnabled: false,
        cacheComponents: false,
        authInterrupts: false,
      },
    },
  });
  const store = createRequestStoreForRender(
    request,
    undefined,
    new URL(request.url),
    {},
    { tags: [], expirationsByCacheKind: new Map() },
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    null,
  );
  return workAsyncStorage.run(work, () =>
    workUnitAsyncStorage.run(store, render),
  );
}
