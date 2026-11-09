// Next calls register() once at server start-up, for EACH runtime it compiles the app for
// (Node and edge). The scheduler is Node-only (it reaches the database through pg), so it is
// imported lazily and only under the Node runtime, the pattern Next documents for
// instrumentation. A static import would pull pg into the edge compile, where its fs
// require cannot resolve and the dev server fails to compile.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
