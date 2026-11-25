// The "use this when" line as a sentence a person reads: the stored line usually starts
// "when …" (kept lower case so it can follow "Use"), so it reads "Use when …". Shared by the
// person's own skills and Warthog's.
export function useWhenLine(text: string): string {
  const line = text.trim();
  if (/^when\b/i.test(line)) return `Use ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}
