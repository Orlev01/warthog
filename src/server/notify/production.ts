import type { Config } from "../config";
import { getServerDb } from "../db/server";
import type { Db } from "../db/index";
import { getUserById, getUserByEmail } from "../db/users";
import { listSubscriptions, removeSubscription } from "../db/push-subscriptions";
import { selectKeyWrapper } from "../crypto/key-wrapper";
import { createGuardedFetch } from "../http/guarded-fetch";
import { systemClock } from "../seams/clock";
import { createResendEmailSender } from "./resend";
import { createTwilioSmsSender } from "./twilio";
import { reserveSmsSegments } from "./sms-budget";
import { createWebPushSender, type PushDeviceSubscription } from "./web-push";
import { selectSenders, type PushSender, type Senders } from "./senders";
import { outbox } from "./outbox";

export function createUserPushSender(deps: {
  subscriptions: (userId: string) => Promise<(PushDeviceSubscription & { id: string })[]>;
  remove: (userId: string, id: string) => Promise<unknown>;
  send: (subscription: PushDeviceSubscription) => Promise<void>;
}): PushSender {
  return {
    sendDevicePush: deps.send,
    async sendPush(message) {
      const devices = await deps.subscriptions(message.recipient);
      if (!devices.length) throw new Error("No registered push device");
      const results = await Promise.allSettled(devices.map(async (device) => {
        try { await deps.send({ endpoint: device.endpoint, keys: device.keys }); }
        catch (error) {
          const status = (error as { status?: number } | null)?.status;
          if (status === 404 || status === 410) await deps.remove(message.recipient, device.id);
          throw new Error("Push delivery failed");
        }
      }));
      if (!results.some((r) => r.status === "fulfilled")) throw new Error("Push delivery failed");
    },
  };
}

// Construction is side-effect free. Provider requests and DB work happen only on send;
// importing a page during next build requires neither credentials nor a database.
export function notificationSenders(config: Config, suppliedDb?: Db): Senders {
  if (config.devTools) return selectSenders(config, { email: outbox, sms: outbox, push: outbox });
  const db = () => suppliedDb ? Promise.resolve(suppliedDb) : getServerDb();
  // Integrity alerts address the account email; other internal callers use its id.
  const person = async (recipient: string) => recipient.includes("@")
    ? getUserByEmail(await db(), recipient) : getUserById(await db(), recipient);
  const webPush = createWebPushSender({ vapid: config.vapid, fetch: createGuardedFetch() });
  const push = createUserPushSender({
    subscriptions: async (userId) => {
      const database = await db();
      const user = await person(userId);
      if (!user) throw new Error("No registered push device");
      const wrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
      const dek = await wrapper.unwrap(user.wrappedDek);
      try { return await listSubscriptions(database, user.id, dek, systemClock); }
      finally { dek.fill(0); }
    },
    remove: async (recipient, id) => {
      const user = await person(recipient);
      if (user) await removeSubscription(await db(), { userId: user.id, id });
    },
    send: webPush.sendNotificationPush,
  });
  return { push,
    email: { async sendEmail(message) {
      if (!config.messaging?.email.apiKey || !config.messaging.email.from) throw new Error("Email sending is not configured");
      await createResendEmailSender(config.messaging.email).sendEmail(message);
    } },
    sms: { async sendSms(message) {
      if (!config.messaging) throw new Error("SMS sending is not configured");
      await createTwilioSmsSender({ ...config.messaging.twilio,
        reserve: async (recipient, segments) => reserveSmsSegments(await db(), config.hmacKey,
          config.messaging!.smsLimits, recipient, segments, systemClock.now()),
      }).sendSms(message);
    } },
  };
}
