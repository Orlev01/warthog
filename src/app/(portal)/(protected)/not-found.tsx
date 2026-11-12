import * as React from "react";

import { NotFoundScreen } from "@/components/shell/status-screens";
import { DocumentTitle } from "@/components/shell/document-title";

// A page under the signed-in area called notFound() (an unknown agent id, a connector that
// doesn't exist): render the not-found panel inside the (protected) layout, so the sidebar,
// top bar and drawer stay mounted and every destination is one click away. Nested not-found
// files can't set metadata, so the tab title is corrected once the page has loaded.
export default function ProtectedNotFound() {
  return (
    <>
      <DocumentTitle title="Page not found · Warthog" />
      <NotFoundScreen variant="workspace" />
    </>
  );
}
