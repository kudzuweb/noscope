#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const built = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
if (!existsSync(built)) {
  process.stderr.write("noscope: not built yet. Run `pnpm build` first.\n");
  process.exit(1);
}
const { run } = await import(built);

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
