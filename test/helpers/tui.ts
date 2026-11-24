/**
 * Polling helpers for Ink component tests. Replace fixed `setTimeout` sleeps
 * (which flake on a loaded runner if too short, and waste time if too long)
 * with "wait until the frame actually shows what we expect".
 */

interface WaitOptions {
  /** Give up after this many ms (default 2000). */
  timeout?: number;
  /** Poll interval in ms (default 5). */
  interval?: number;
}

/** Resolve once `predicate()` is true; reject if it never is within `timeout`. */
export async function waitFor(predicate: () => boolean, opts: WaitOptions = {}): Promise<void> {
  const { timeout = 2000, interval = 5 } = opts;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeout) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, interval));
  }
}

type Frame = () => string | undefined;
type FrameMatch = string | ((frame: string) => boolean);

const matches = (frame: string, m: FrameMatch): boolean =>
  typeof m === "string" ? frame.includes(m) : m(frame);

/** Wait until the rendered frame satisfies `match` (a substring or predicate). */
export async function waitForFrame(
  lastFrame: Frame,
  match: FrameMatch,
  opts: WaitOptions = {},
): Promise<void> {
  try {
    await waitFor(() => matches(lastFrame() ?? "", match), opts);
  } catch {
    const desc = typeof match === "string" ? `substring ${JSON.stringify(match)}` : "predicate";
    throw new Error(
      `waitForFrame: ${desc} never matched.\nLast frame:\n${lastFrame() ?? "(none)"}`,
    );
  }
}

/** Wait until the rendered frame no longer satisfies `match` (e.g. an overlay closed). */
export function waitForFrameGone(
  lastFrame: Frame,
  match: FrameMatch,
  opts?: WaitOptions,
): Promise<void> {
  return waitForFrame(lastFrame, (frame) => !matches(frame, match), opts);
}

/**
 * Write `data` to stdin until the frame satisfies `match`. A key written
 * before a component's `useInput` effect has registered is dropped, so the
 * write is retried (the predicate is checked first, so it never repeats once
 * the key has landed and rendered).
 */
export async function writeUntil(
  stdin: { write: (data: string) => void },
  data: string,
  lastFrame: Frame,
  match: FrameMatch,
  opts: WaitOptions & { retryEvery?: number } = {},
): Promise<void> {
  const { retryEvery = 100, timeout = 3000, interval = 5 } = opts;
  const start = Date.now();
  let lastWrite = -Infinity;
  while (!matches(lastFrame() ?? "", match)) {
    const now = Date.now();
    if (now - start >= timeout) {
      throw new Error(`writeUntil: frame never matched.\nLast frame:\n${lastFrame() ?? "(none)"}`);
    }
    if (now - lastWrite >= retryEvery) {
      stdin.write(data);
      lastWrite = now;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
