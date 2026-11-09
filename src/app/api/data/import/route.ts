import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { createTransferImportHandler } from "@/server/import/transfer-handler";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  const config = loadConfig();
  return createTransferImportHandler({ db: await getServerDb(), clock: systemClock, keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }), publicOrigin: new URL(config.publicBaseUrl).origin })(request);
}
