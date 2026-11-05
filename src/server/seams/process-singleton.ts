// Process-wide singletons that survive module duplication. Next compiles route handlers and
// pages into separate module graphs (and re-evaluates modules on dev reloads), so a module-level
// `export const x = create()` can exist once per graph: one route writes to its copy while a page
// reads another, empty one. Every process-wide store (dev outbox, release store, pending sign-ups
// and device requests, …) is therefore created through here: the instance lives on globalThis
// under `Symbol.for("warthog." + name)`, so every copy of a module resolves the same one.
export function processSingleton<T>(name: string, create: () => T): T {
  const key = Symbol.for(`warthog.${name}`);
  const g = globalThis as Record<symbol, unknown>;
  if (!(key in g)) g[key] = create();
  return g[key] as T;
}
