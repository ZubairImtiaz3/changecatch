// Journal offsets are UUIDv7 strings (e.g. 01a18abd-74f4-7…): time-ordered, and the first 48 bits are the Unix ms
// time HubSpot published that journal file.

/** The publish time (epoch ms) of a UUIDv7 journal offset. null for anything else (e.g. test offsets). */
export function offsetTimeMs(offset: string): number | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(offset.trim());
  if (!m) return null;
  const t = parseInt(m[1] + m[2], 16);
  return t > 1_500_000_000_000 && t < 4_000_000_000_000 ? t : null;
}

/** Offsets are time-ordered: compare as lower-case strings. */
export function compareOffsets(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
