import * as React from "react";
import { PolicyLinks } from "@/components/public/policy-links";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}<footer><PolicyLinks /></footer></>;
}
