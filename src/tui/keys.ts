/**
 * Index of `input` within `keys` (e.g. "123" → panel/view number keys), or -1.
 *
 * Guards the Ink footgun where non-character keys (arrows, backspace, home,
 * F-keys) arrive as `input === ""`, and `"123".indexOf("")` is 0 — which would
 * otherwise make every such key register as the first number key.
 */
export function keyIndex(keys: string, input: string): number {
  return input ? keys.indexOf(input) : -1;
}
