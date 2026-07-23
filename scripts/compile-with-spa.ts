#!/usr/bin/env bun
// Compiles from a disposable source copy containing the embedded Vite build.
// The tracked placeholder is never modified, even if the build is interrupted.
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const htmlPath = fileURLToPath(new URL("../web/dist/index.html", import.meta.url));

const args = Bun.argv.slice(2);
if (args[0] === "--") args.shift();
if (args.length === 0) {
  console.error("Usage: bun run scripts/compile-with-spa.ts -- <bun build arguments>");
  process.exit(2);
}

const htmlFile = Bun.file(htmlPath);
if (!(await htmlFile.exists())) {
  console.error(`Build output not found at ${htmlPath}. Run \`bun run build:web\` first.`);
  process.exit(1);
}

const html = await htmlFile.text();
const embeddedSpa = `// GENERATED in a disposable build tree by scripts/compile-with-spa.ts.
export const spaHtml = ${JSON.stringify(html)};
export const hasSpa = true;
`;

const tempBase = join(repoRoot, "tmp");
await mkdir(tempBase, { recursive: true });
const tempRoot = await mkdtemp(join(tempBase, "compile-spa-"));
let exitCode = 1;
try {
  await cp(join(repoRoot, "src"), join(tempRoot, "src"), { recursive: true });
  await cp(join(repoRoot, "package.json"), join(tempRoot, "package.json"));
  await Bun.write(join(tempRoot, "src/web/spa.ts"), embeddedSpa);
  const buildArgs = args.map((arg) =>
    arg.startsWith("src/") ? join(tempRoot, ...arg.split("/")) : arg,
  );
  console.log(`Embedded ${(html.length / 1024).toFixed(0)} KB SPA in disposable build tree`);
  const child = Bun.spawn(["bun", "build", ...buildArgs], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await child.exited;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

process.exit(exitCode);
