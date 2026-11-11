import { z } from "zod";

// Notifications contain opaque routing data only; personal record content is
// fetched after the recipient opens an authenticated, owner-scoped page.
export const recordNotificationSchema = z.object({
  recordId: z.uuid(),
  recordTab: z.enum(["subscriptions", "receipts", "renewals"]),
});
export type RecordNotification = z.infer<typeof recordNotificationSchema>;

export function recordNotificationFromLink(link: string | undefined): RecordNotification | undefined {
  const match = link?.match(/^\/life-admin\?view=life&tab=(subscriptions|receipts|renewals)#record-([0-9a-f-]+)$/i);
  if (!match) return undefined;
  const parsed = recordNotificationSchema.safeParse({ recordId: match[2], recordTab: match[1] });
  return parsed.success ? parsed.data : undefined;
}
