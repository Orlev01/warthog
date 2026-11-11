// Package files and per-skill access share a dialog. Serialize their writes so
// a successful save cannot reload the page over another in-flight operation.
export function createPackageOperation(deps: {
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  let busy = false;
  return {
    isBusy: () => busy,
    async run(action: () => Promise<void>): Promise<void> {
      if (busy) return;
      busy = true;
      deps.onBusy(true);
      deps.onError("");
      try {
        await action();
      } catch {
        deps.onError("Could not complete that action. Please try again.");
      } finally {
        busy = false;
        deps.onBusy(false);
      }
    },
  };
}
