export const RECEIPT_MAX_BYTES = 25 * 1024 * 1024;

export function receiptUploadError(size: number): string | null {
  if (!Number.isSafeInteger(size) || size <= 0) return "Choose a non-empty file.";
  return size > RECEIPT_MAX_BYTES ? "Choose a file of 25 MiB or less." : null;
}
