import * as React from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Info } from "lucide-react";
import { UrlParamCleanup } from "./url-param-cleanup";

export type NoticeTone = "info" | "success" | "warning" | "error";

const tones = {
  info: { Icon: Info, color: "text-info" },
  success: { Icon: CheckCircle2, color: "text-success" },
  warning: { Icon: AlertTriangle, color: "text-warning" },
  error: { Icon: CircleAlert, color: "text-danger" },
};

// Persistent contextual feedback. The surrounding page owns width and spacing;
// instructions and errors never disappear on a timer or rely on colour alone.
export function Notice({ tone = "info", announce = true, children, className }: {
  tone?: NoticeTone;
  // Static help should remain readable without announcing a new event.
  announce?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const { Icon, color } = tones[tone];
  return (
    <div role={announce ? (tone === "error" ? "alert" : "status") : undefined} aria-atomic={announce ? true : undefined}
      data-tone={tone}
      className={["wh-notice flex min-w-0 items-start gap-3 rounded-card border border-line bg-surface p-4 text-sm text-fg", className].filter(Boolean).join(" ")}>
      <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

// The page-level outcome slot: the result of the last action ("Saved.", "Agent disconnected."),
// placed as the first child of .wh-page straight after WorkspaceHeading — never above the
// route tabs, never in a wrapper of its own — so it always sits at the page's width and left
// edge, next to the content it describes. It announces itself (errors as alerts) and, by
// default, removes `?notice=` from the address bar once shown, so a refresh or Back doesn't
// replay it. Pass `clearParams={[]}` to keep the URL as it is.
export function PageNotice({
  tone = "success",
  children,
  clearParams = ["notice"],
}: {
  tone?: NoticeTone;
  children: React.ReactNode;
  clearParams?: readonly string[];
}) {
  return (
    <>
      <Notice tone={tone} className="wh-page-notice">
        {children}
      </Notice>
      {clearParams.length ? <UrlParamCleanup names={clearParams} /> : null}
    </>
  );
}
