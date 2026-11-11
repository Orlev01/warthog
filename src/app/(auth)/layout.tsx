import * as React from "react";
import { PolicyLinks } from "@/components/public/policy-links";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="wh-auth-page">{children}<footer className="wh-auth-footer"><PolicyLinks /></footer></div>;
}
