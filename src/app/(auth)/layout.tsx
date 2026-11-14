import * as React from "react";
import { PolicyLinks } from "@/components/public/policy-links";
import { WebsiteHome } from "@/components/public/website-home";
import { publicLinksFromEnv } from "@/server/config";

// Account-entry frame: each screen renders its own brand bar and <main> (AuthScreen); this
// layout adds the full-width footer bar with Help, Privacy and Terms (public-27), and tells
// the screens where home is: the website, when it has its own host.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="wh-auth-page">
      <WebsiteHome href={publicLinksFromEnv().home}>{children}</WebsiteHome>
      <footer className="wh-auth-footer wh-public-bar">
        <div className="wh-public-bar-inner wh-public-footer-inner"><PolicyLinks help /></div>
      </footer>
    </div>
  );
}
