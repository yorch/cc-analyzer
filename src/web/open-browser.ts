/** Platform command used to open a URL in the user's default browser. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "linux":
      return ["xdg-open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return undefined;
  }
}

/** Best-effort browser launch. Serving must succeed even when no opener exists. */
export function openBrowser(url: string): boolean {
  const command = browserCommand(url);
  if (!command) return false;
  try {
    const child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
