import * as React from "react";

import { CopyButton } from "../ui/copy-button";

// A raw base32 recovery code shown in groups of four ("ABCD EFGH …", design §4.2), so it
// is easy to copy by hand; the server accepts it back with or without the spaces. A code
// that already carries separators is shown as given.
export function groupRecoveryCode(code: string | undefined): string | undefined {
  if (code === undefined || !/^[A-Z2-7]{8,}$/.test(code)) return code;
  return code.match(/.{1,4}/g)!.join(" ");
}

// The shown-once recovery code as read-only text (never an editable form value), laid out
// as groups that never split across lines (public-15), with a Copy action beside it. The
// copy feedback never repeats the code.
export function RecoveryCodeDisplay({ code, label = "Your recovery code" }: { code?: string; label?: string }) {
  const grouped = groupRecoveryCode(code);
  const groups = grouped ? grouped.split(/\s+/).filter(Boolean) : [];
  return (
    <div className="wh-auth-recovery">
      <span className="text-sm font-medium text-fg">{label}</span>
      <p className="wh-auth-recovery-code">
        {groups.map((group, index) => (
          <React.Fragment key={index}>{index ? " " : null}<span>{group}</span></React.Fragment>
        ))}
      </p>
      {grouped ? <CopyButton value={grouped} successMessage="Recovery code copied. Keep it somewhere safe." /> : null}
    </div>
  );
}
