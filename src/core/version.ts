import pkg from "../../package.json";

/**
 * The running cc-analyzer version, embedded from package.json at build time.
 * `bun build --compile` bundles the JSON import, so the standalone binary knows
 * its own version; running from source reads the same file.
 */
export const VERSION: string = pkg.version;
