// The metrics recorder — the SINGLE guarded write path for operational metrics (task
// E17-S02). The one rule for metrics is that they carry NO personal content; this module
// enforces it at the single write path so no caller can smuggle an identity value, message
// or tool parameter into metrics, regardless of the caller.
//
// A metric is a NAMED numeric value plus an OPTIONAL, OPEN map of dimensions. The guard:
//   • the value must be a FINITE number (NaN / +Infinity / -Infinity are rejected —
//     "accepting only a numeric value");
//   • every dimension key must be on the allowlist {platform, connectorId, outcome,
//     errorCategory} — the four constrained, non-personal dimensions of the E17-S01 store;
//     any other key is a smuggling vector and is rejected;
//   • every dimension value must be a SHORT IDENTIFIER LABEL (or null) — free text, prose,
//     an email/identity value, an oversized string or a structured object (the shape tool
//     parameters arrive in) is rejected.
// On any violation the recorder REJECTS and writes NOTHING: validation runs BEFORE the
// single INSERT, so a rejected metric never reaches a query.
//
// A well-formed metric is stamped with the instant from the injected clock (never
// Date.now()) and written as ONE row THROUGH E17-S01's `recordMetric`, where every field
// travels BOUND as a parameter (constitution INV-102). Operational numbers are GLOBAL, not
// member-scoped — so the guard here is the allowlist, not DEK-encryption or a userId scope.
// This module reads no `process.env` and holds no secret (INV-103): it runs purely from the
// injected db + clock + input.

import type { Db } from "../db/index";
import { recordMetric } from "../db/metrics";
import type { Clock } from "../seams/clock";

// What the recorder takes: the operational metric name, a finite numeric value, and an
// OPTIONAL open map of dimensions. Only allowlisted keys with short-identifier string (or
// null) values survive the guard; any other key, or a free-text / structured value, is
// rejected and nothing is stored.
export interface RecordMetricInput {
  readonly name: string;
  readonly value: number;
  readonly dimensions?: Record<string, unknown>;
}

// The four allowlisted dimension keys — the E17-S01 store's constrained, non-personal
// dimensions. A metric may carry only these; any other key is rejected outright.
const ALLOWED_DIMENSION_KEYS = ["platform", "connectorId", "outcome", "errorCategory"] as const;
type AllowedDimensionKey = (typeof ALLOWED_DIMENSION_KEYS)[number];
const ALLOWED = new Set<string>(ALLOWED_DIMENSION_KEYS);

// A dimension is a SHORT, SAFE identifier label: an alphanumeric first character, then up to
// 63 more alphanumerics / `_` / `.` / `-`. Prose (spaces, punctuation), an email (`@`), an
// oversized string or an injection probe does not match, so none can pass as a dimension.
const DIMENSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/;

// The SINGLE guarded write path. Enforces a finite numeric value and the dimension-key
// allowlist + short-identifier value shape, stamps the instant from `clock`, maps each
// allowlisted dimension onto its E17-S01 column, then writes ONE row through `recordMetric`
// with every field bound. On a guard violation it rejects and writes nothing.
export async function recordMetricEvent(db: Db, clock: Clock, input: RecordMetricInput): Promise<void> {
  if (!Number.isFinite(input.value)) {
    throw new Error("metric value must be a finite number");
  }
  const dimensions = guardDimensions(input.dimensions);
  await recordMetric(db, {
    name: input.name,
    value: input.value,
    recordedAt: clock.now().toISOString(),
    ...dimensions,
  });
}

// Validate the open dimension map against the allowlist and the short-identifier shape,
// returning only the allowlisted columns (present keys mapped to their string or null
// value). Throws — before any query is issued — on a non-allowlisted key or a free-text /
// structured value. The offending key/value is never echoed into the error, so a rejection
// cannot leak smuggled content.
function guardDimensions(
  dimensions: Record<string, unknown> | undefined,
): Partial<Record<AllowedDimensionKey, string | null>> {
  const guarded: Partial<Record<AllowedDimensionKey, string | null>> = {};
  if (dimensions == null) return guarded;
  for (const key of Object.keys(dimensions)) {
    if (!ALLOWED.has(key)) {
      throw new Error("metric dimension key is not on the allowlist");
    }
    const value = dimensions[key];
    if (value == null) {
      guarded[key as AllowedDimensionKey] = null;
      continue;
    }
    if (typeof value !== "string" || !DIMENSION_LABEL.test(value)) {
      throw new Error("metric dimension value must be a short identifier label");
    }
    guarded[key as AllowedDimensionKey] = value;
  }
  return guarded;
}
