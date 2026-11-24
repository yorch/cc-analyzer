// Shared by server.ts and api.ts (kept apart to avoid an import cycle).

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** Whether a bind address / Host name is loopback. Parses via the URL host
 *  grammar so odd IPv6 spellings and trailing ports normalize consistently. */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  // Bracket a bare IPv6 literal (multiple colons, unbracketed) — a bind address
  // like "::1" is legal but the URL host grammar needs the brackets.
  if (!h.startsWith("[") && (h.match(/:/g)?.length ?? 0) > 1) h = `[${h}]`;
  let name: string;
  try {
    name = new URL(`http://${h}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  return LOOPBACK.has(name);
}
