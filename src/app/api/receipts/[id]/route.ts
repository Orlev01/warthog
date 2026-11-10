import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectBlobStore } from "@/server/storage/blob";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { createReceiptDownloadHandler } from "@/server/storage/receipt-download";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const config = loadConfig();
  const handler = createReceiptDownloadHandler({
    db: await getServerDb(), clock: systemClock,
    blob: selectBlobStore({ nodeEnv: config.nodeEnv, account: config.blob.account, container: config.blob.container }),
    keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }),
  });
  return handler(request, (await context.params).id);
}
