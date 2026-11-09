import * as React from "react";
import { SUPPORT_EMAIL } from "./operator";

export function SmsDisclosure({ purpose }: { purpose: "verification" | "alerts" }) {
  return <p className="text-sm text-fg-muted">
    {purpose === "verification"
      ? "By selecting Send code, you request one Warthog verification text to the number you entered. This does not subscribe you to approval alerts."
      : "By enabling SMS and saving preferences, you agree to receive Warthog approval alerts at your verified number. Message frequency varies with your approval activity. SMS is optional and is not required to use Warthog."}
    {" "}Message and data rates may apply. Reply STOP to stop texts or HELP for help.
    {" "}You can also contact <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
    {" "}Read the <a className="underline" href="/terms">Terms of use</a> and <a className="underline" href="/privacy">Privacy policy</a>.
  </p>;
}
