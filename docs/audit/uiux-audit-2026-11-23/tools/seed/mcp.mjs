// Tiny MCP client over Warthog's /mcp (local dev only).
const BASE = process.env.BASE ?? "http://localhost:3241";
let id = 0;
export async function rpc(token, method, params = {}) {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : raw);
}
export async function call(token, name, args = {}) {
  const j = await rpc(token, "tools/call", { name, arguments: args });
  const text = j.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(j.error ?? j);
  return { ok: !j.error && !j.result?.isError, text, structured: j.result?.structuredContent };
}
