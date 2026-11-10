"use client";

import { useFormStatus } from "react-dom";
import { Button } from "./button";

export function FormSubmit({
  children,
  pendingLabel,
}: {
  children: React.ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="primary"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
