/**
 * Clipboard write that reports failure instead of throwing.
 *
 * `navigator.clipboard` only exists in a **secure context**. `cc-analyzer serve
 * --host 0.0.0.0` is served over plain http, so a phone or another laptop on
 * the LAN gets a `navigator` with no `clipboard` at all — and reaching for
 * `navigator.clipboard.writeText(…)` there throws a synchronous TypeError that
 * no `.catch()` on the (never-constructed) promise can absorb. Feature-detect
 * first, then delegate, and let the caller render one "couldn't copy" state for
 * both the missing-API and permission-denied cases.
 *
 * Kept DOM-free in its signature (a minimal structural host, injectable) so it
 * is unit-testable outside a browser.
 */

export interface ClipboardHost {
  clipboard?: { writeText?: (text: string) => Promise<void> };
}

function defaultHost(): ClipboardHost | undefined {
  return (globalThis as { navigator?: ClipboardHost }).navigator;
}

/** True when the text reached the clipboard; false for any reason it didn't. */
export async function copyText(
  text: string,
  host: ClipboardHost | undefined = defaultHost(),
): Promise<boolean> {
  const write = host?.clipboard?.writeText;
  if (typeof write !== "function") return false;
  try {
    await write.call(host?.clipboard, text);
    return true;
  } catch {
    return false;
  }
}
