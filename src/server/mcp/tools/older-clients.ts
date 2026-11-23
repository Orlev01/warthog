// Calls from agents whose client cached an older list of Warthog's tools.
//
// Some clients keep the tool list they fetched when the person first connected them (ChatGPT
// until the person refreshes the connector; others until they reconnect). Such an agent reads
// today's "Life admin records" skill but can only send the record tools' older parameters —
// kind, fields, dueDate, status — so it does one of two things with the newer ones:
//   - puts them inside fields: {"kind": "renewal_appointment", "fields": {"type":
//     "vehicles.registration", "source": {…}, …}};
//   - sends them anyway, as JSON text: {"source": "{\"service\":\"gmail\",…}", "limit": "5"}.
// Both are lifted here into the parameters they meant, before the schema checks them, so the
// record is filed as the kind the agent meant with the source Warthog checks — rather than as
// "Renewal or appointment" with its kind and source shown as two of its fields.
//
// Only what is unmistakable is lifted: a kind id that matches the type pattern, an object for
// source or journal, a list for details or records, a uuid for parentId, a number for a numeric
// parameter. A current call is left exactly as it was: its own parameters always win, and a
// field named "type" that isn't a kind id ("naked", "general") stays a field.

const TYPE_ID = /^(?:[a-z]+|x_[bcdfghjkmnpqrstvwxz2-9]{6}|new)\.[a-z][a-z0-9_]{0,23}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain => typeof value === "object" && value !== null && !Array.isArray(value);

// The parameters a stale client sends as JSON text, and what each must parse to.
const JSON_PARAMS: Readonly<Record<string, "object" | "array">> = {
  fields: "object",
  set: "object",
  source: "object",
  journal: "object",
  newCategory: "object",
  details: "array",
  records: "array",
};
const NUMBER_PARAMS = new Set(["limit", "dueWithinDays"]);
const BOOLEAN_PARAMS = new Set(["takeOver"]);

function fromText(value: unknown, shape: "object" | "array"): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!(shape === "object" ? text.startsWith("{") : text.startsWith("["))) return value;
  try {
    const parsed: unknown = JSON.parse(text);
    return (shape === "object" ? isPlain(parsed) : Array.isArray(parsed)) ? parsed : value;
  } catch {
    return value;
  }
}

function parametersFromText(input: Plain): Plain {
  const out: Plain = { ...input };
  for (const [key, value] of Object.entries(input)) {
    const shape = JSON_PARAMS[key];
    if (shape) out[key] = fromText(value, shape);
    else if (NUMBER_PARAMS.has(key) && typeof value === "string" && /^\d{1,6}$/.test(value.trim())) out[key] = Number(value.trim());
    else if (BOOLEAN_PARAMS.has(key) && value === "true") out[key] = true;
  }
  return out;
}

// What may be lifted out of fields, and how to recognise it.
const LIFTED: ReadonlyArray<readonly [string, (value: unknown) => unknown]> = [
  ["type", (value) => (typeof value === "string" && TYPE_ID.test(value) ? value : undefined)],
  ["source", (value) => (isPlain(fromText(value, "object")) && typeof (fromText(value, "object") as Plain).service === "string" ? fromText(value, "object") : undefined)],
  ["details", (value) => (Array.isArray(fromText(value, "array")) ? fromText(value, "array") : undefined)],
  ["journal", (value) => (isPlain(fromText(value, "object")) ? fromText(value, "object") : undefined)],
  ["parentId", (value) => (typeof value === "string" && UUID.test(value) ? value : undefined)],
  ["takeOver", (value) => (value === true || value === "true" ? true : undefined)],
];

function liftRecord(record: Plain): Plain {
  const out = parametersFromText(record);
  for (const container of ["fields", "set"] as const) {
    const fields = out[container];
    if (!isPlain(fields)) continue;
    const kept: Plain = { ...fields };
    for (const [key, recognise] of LIFTED) {
      if (!(key in fields) || out[key] !== undefined) continue;
      const value = recognise(fields[key]);
      if (value === undefined) continue;
      out[key] = value;
      delete kept[key];
    }
    out[container] = kept;
  }
  // An older client must send kind; once it says which kind it means, that wins.
  if (typeof out.type === "string" && out.kind !== undefined) delete out.kind;
  return out;
}

/** A record tool's input with an older client's parameters lifted into the ones it meant. */
export function liftOlderClientInput(input: unknown): unknown {
  if (!isPlain(input)) return input;
  const out = liftRecord(input);
  if (Array.isArray(out.records)) {
    out.records = out.records.map((record) => (isPlain(record) ? liftRecord(record) : record));
    // An older client must send kind and fields even with records; empty ones mean nothing.
    if (isPlain(out.fields) && Object.keys(out.fields).length === 0) delete out.fields;
    if (out.type === undefined) delete out.kind;
  }
  return out;
}

// The record tools, whose calls an older client makes in the older shape.
const RECORD_TOOLS = new Set(["save_record", "update_record", "list_records"]);

/**
 * A JSON-RPC body with a record tool call's arguments lifted (the same body when nothing
 * changes), so the SDK, which checks arguments against today's schema before any tool body
 * runs, accepts an older client's call.
 */
export function liftOlderClientCall(body: unknown): unknown {
  if (!isPlain(body) || body.method !== "tools/call" || !isPlain(body.params)) return body;
  const { name, arguments: args } = body.params;
  if (typeof name !== "string" || !RECORD_TOOLS.has(name) || !isPlain(args)) return body;
  const lifted = liftOlderClientInput(args);
  if (JSON.stringify(lifted) === JSON.stringify(args)) return body;
  return { ...body, params: { ...body.params, arguments: lifted } };
}
