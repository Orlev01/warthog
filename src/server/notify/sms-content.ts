const GSM = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const GSM_EXT = new Set(Array.from("\f^{}\\[~]|€"));

// GSM extension characters use two septets. Non-GSM content is UTF-16, including
// surrogate pairs; concatenated messages have smaller per-part capacities.
export function smsSegments(text: string, conservativeTollFree = false): number {
  if (!text || text.length > 1600) throw new Error("Invalid SMS message length");
  const chars = Array.from(text);
  const gsm = chars.every((c) => GSM.has(c) || GSM_EXT.has(c));
  const widths = chars.map((c) => gsm ? (GSM_EXT.has(c) ? 2 : 1) : c.length);
  const total = widths.reduce((sum, n) => sum + n, 0);
  if (total <= (gsm ? 160 : 70)) return 1;
  // Count whole characters so GSM escape and UTF-16 surrogate pairs never
  // straddle parts. Rounding the total alone can underestimate paid segments.
  // US/Canada toll-free multipart capacity is smaller. Reserve conservatively
  // when the provider selects a sender from a pool whose final type is unknown.
  const capacity = gsm ? (conservativeTollFree ? 152 : 153) : (conservativeTollFree ? 66 : 67);
  let parts = 1, used = 0;
  for (const width of widths) {
    if (used + width > capacity) { parts++; used = 0; }
    used += width;
  }
  return parts;
}
