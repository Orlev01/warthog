import * as React from "react";

// Focused portal content shares this width and gutter. Views that already own a
// centred container must not be wrapped again, or their padding doubles.
export function PageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={["mx-auto min-w-0 w-full max-w-2xl px-4 py-8 sm:px-6", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export default PageContainer;
