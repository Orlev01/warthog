-- 0044_metrics — the operational metric-events store (task E17-S01; brief "Operations
-- readiness": "Operational metrics recorded from day one without any personal content —
-- user and household counts, active agents by platform, connector connection counts and
-- failure rates by connector, request volumes and latencies, approval response times,
-- errors"; design "THE SYSTEM SHALL record operational metrics (counts, rates, latencies,
-- error categories) without any personal content, identity value, message content or tool
-- parameters").
--
-- An APPEND-ONLY log of NAMED operational numbers: one row per recorded metric, carrying
-- the metric name, a numeric value, the instant it was recorded, and a SMALL FIXED set of
-- non-personal dimensions (agent platform, connector catalogue id, outcome, error
-- category). recordMetric APPENDS (it never upserts/overwrites/dedupes); queryMetrics reads
-- a single metric name over an inclusive time range, oldest-first.
--
-- A table of named metrics with a numeric value and a few CONSTRAINED, non-personal
-- dimensions is a shape that STRUCTURALLY CANNOT hold personal content: there is NO
-- json/jsonb column and NO free-text column — every text-bearing column is a short,
-- length-capped identifier (the name and the four dimensions), so none can hold an identity
-- value, message content or tool parameters. The admin app that reads these later therefore
-- never gains a path to vault contents (constitution principle 19). The length CHECKs are
-- schema-level guards that keep each column to a short identifier; a grossly oversized
-- string is rejected by the database and no row is written.
--
-- Operational numbers are GLOBAL operational data, NOT member-scoped personal content — so,
-- like the exchange rates and unlike vault fields, cards or released values, they are
-- PLAINTEXT and NOT DEK-encrypted, and no row is bound to a person. `value` is numeric
-- (exact; a count, rate or latency reads back at its stored precision). `id` is a generated
-- surrogate key giving each appended row its own identity. Every value is bound as a
-- parameter at the data-access seam (INV-102).

CREATE TABLE metric_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL CHECK (char_length(name) <= 100),
  value          numeric NOT NULL,
  recorded_at    timestamptz NOT NULL,
  platform       text CHECK (char_length(platform) <= 64),
  connector_id   text CHECK (char_length(connector_id) <= 64),
  outcome        text CHECK (char_length(outcome) <= 64),
  error_category text CHECK (char_length(error_category) <= 64)
);

-- queryMetrics reads one metric name over an inclusive [from, to] range, oldest-first
-- (WHERE name = $1 AND recorded_at BETWEEN $2 AND $3 ORDER BY recorded_at), so index that
-- name + time lookup.
CREATE INDEX metric_events_name_recorded_idx
  ON metric_events (name, recorded_at);
