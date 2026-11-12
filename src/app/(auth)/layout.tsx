import * as React from "react";
import { PolicyLinks } from "@/components/public/policy-links";

// Account-entry frame: each screen renders its own brand bar and <main> (AuthScreen); this
// layout adds the full-width footer bar with Help, Privacy and Terms (public-27).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="wh-auth-page">
      {children}
      <footer className="wh-auth-footer wh-public-bar">
        <div className="wh-public-bar-inner wh-public-footer-inner"><PolicyLinks help /></div>
      </footer>
    </div>
  );
}
