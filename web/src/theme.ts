/**
 * Web color-theme preference: System / Light / Dark.
 *
 * The SPA's palette has always shipped both a dark and a light token set (see
 * `styles.css`); this module is only the *selection* layer that lets a user
 * override the OS default. The choice is stored **per-browser in localStorage**,
 * never in the server's `prefs.json`, because a theme follows the *display*, not
 * the data — you may want dark on a laptop and light on a projector viewing the
 * same `serve` instance. `cost-basis` lives server-side for the opposite reason
 * (it must read identically across the CLI, TUI, and web).
 *
 * An inline `<head>` script in `web/index.html` reads the same key and stamps
 * the resolved concrete theme onto `<html data-theme>` before first paint, so
 * there is no flash of the wrong theme; this module is the React-side
 * counterpart that reads/writes the preference and keeps a "system" choice live
 * when the OS theme flips while the page is open.
 *
 * Pure resolution (`normalizeThemePref`, `resolveTheme`) is split from the DOM
 * so it unit-tests outside a browser, mirroring `clipboard.ts`. Browser globals
 * are reached structurally through `globalThis` (not bare `window`/`document`)
 * for the same reason clipboard.ts does: this file is pulled into the root,
 * DOM-free typecheck through its test, so it must compile without the DOM lib.
 * The storage key is duplicated as a literal in the inline `index.html` script —
 * keep the two in sync (there is no way to import a constant into pre-paint
 * inline HTML).
 */

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** localStorage key. Mirrored verbatim by the inline script in web/index.html. */
export const THEME_STORAGE_KEY = "cc-theme";

/** Selectable preferences, in display order. */
export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"] as const;

/** Coerce arbitrary storage/user input to a known preference; anything
 *  unrecognized (including `null`) reads as "system". */
export function normalizeThemePref(value: unknown): ThemePref {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

/** The concrete theme a preference resolves to, given whether the OS currently
 *  prefers light. An explicit light/dark wins; "system" defers to the OS. */
export function resolveTheme(pref: ThemePref, systemPrefersLight: boolean): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return systemPrefersLight ? "light" : "dark";
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The slice of the browser this module touches, reached structurally so the
 *  file compiles under the DOM-free root tsconfig (see the module header). */
interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}
interface ThemeGlobals {
  document?: { documentElement: { dataset: { theme?: string } } };
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  matchMedia?: (query: string) => MediaQueryLike;
}
function browser(): ThemeGlobals {
  return globalThis as unknown as ThemeGlobals;
}

function systemPrefersLight(): boolean {
  try {
    return browser().matchMedia?.(LIGHT_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** The user's stored preference (defaults to "system"). */
export function getThemePref(): ThemePref {
  try {
    return normalizeThemePref(browser().localStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Stamp the concrete resolved theme onto `<html data-theme>`. */
export function applyThemePref(pref: ThemePref): void {
  try {
    const root = browser().document?.documentElement;
    if (root) root.dataset.theme = resolveTheme(pref, systemPrefersLight());
  } catch {
    // No DOM (e.g. SSR/test) — nothing to paint.
  }
}

/** Persist the preference and re-paint. Best-effort: a blocked localStorage
 *  (private mode, disabled storage) still updates the live theme. */
export function setThemePref(pref: ThemePref): void {
  try {
    browser().localStorage?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
  applyThemePref(pref);
}

/** Keep a "system" preference live: re-apply when the OS theme flips. A no-op
 *  when the preference is explicit. Returns a cleanup fn; no-op if `matchMedia`
 *  is unavailable. */
export function watchSystemTheme(): () => void {
  try {
    const mq = browser().matchMedia?.(LIGHT_QUERY);
    if (!mq) return () => {};
    const onChange = () => {
      if (getThemePref() === "system") applyThemePref("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  } catch {
    return () => {};
  }
}
