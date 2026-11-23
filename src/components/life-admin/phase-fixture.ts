// A helper for the Life admin view tests: a record with its phase worked out as the loader
// does (`domain/life-admin/lifecycle.ts`), at a fixed instant in the person's zone, so a test
// can render the view the way the page does without a database. Not used by the app.

import { BUILT_IN, type Catalogue } from "@/domain/life-admin/catalogue";
import { phaseOf } from "@/domain/life-admin/lifecycle";
import type { LifeAdminRecordView } from "./record-view-types";

export const FIXTURE_NOW = new Date("2026-11-23T01:00:00.000Z"); // midday in Sydney
export const FIXTURE_ZONE = "Australia/Sydney";

export function phased(record: LifeAdminRecordView, now = FIXTURE_NOW, zone = FIXTURE_ZONE, catalogue: Catalogue = BUILT_IN): LifeAdminRecordView {
  const type = catalogue.typeOfRecord(record.kind, record.type ?? null);
  const p = phaseOf({ status: record.status, state: record.state ?? null, dueDate: record.dueDate, fields: record.fields }, type, now, zone);
  return {
    ...record,
    phase: {
      phase: p.phase, bucket: p.bucket, live: p.live, label: p.label, comingUp: p.comingUp,
      ...(p.inDays !== undefined ? { inDays: p.inDays } : {}),
      ...(p.starts ? { starts: p.starts.toISOString() } : {}),
      ...(p.ends ? { ends: p.ends.toISOString() } : {}),
    },
  };
}
