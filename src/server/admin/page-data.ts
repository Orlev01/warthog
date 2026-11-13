// The admin portal's page loaders (docs/design/admin-portal.md §5): one per page, each
// composing the allowlisted reads (./reads.ts) into that page's view model
// (src/domain/admin/model.ts). PLACEHOLDER signatures — the reads slice fills them in.

import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { MetricSeam } from "../metrics/seam";
import type {
  AccountsModel, OverviewModel, RangeKey, ReliabilityModel, SignupsModel, SystemModel, TrafficModel, UsageModel,
} from "../../domain/admin/model";

export interface AdminPageDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly smsEnabled: boolean;
  readonly azureMetricsUrl?: string | null;
  readonly recordMetric?: MetricSeam;
}

function notImplemented(): never {
  throw new Error("admin page loader not implemented yet");
}

export async function loadOverview(_deps: AdminPageDeps, _range: RangeKey): Promise<OverviewModel> { return notImplemented(); }
export async function loadSignups(_deps: AdminPageDeps, _range: RangeKey): Promise<SignupsModel> { return notImplemented(); }
export async function loadUsage(_deps: AdminPageDeps, _range: RangeKey): Promise<UsageModel> { return notImplemented(); }
export async function loadAccounts(_deps: AdminPageDeps, _input: { email?: string | null; filter?: string | null }): Promise<AccountsModel> { return notImplemented(); }
export async function loadReliability(_deps: AdminPageDeps, _range: RangeKey): Promise<ReliabilityModel> { return notImplemented(); }
export async function loadTraffic(_deps: AdminPageDeps, _range: RangeKey): Promise<TrafficModel> { return notImplemented(); }
export async function loadSystem(_deps: AdminPageDeps): Promise<SystemModel> { return notImplemented(); }
