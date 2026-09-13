#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const built = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
if (!existsSync(built)) {
  console.error("noscope: not built yet. Run `pnpm build` first.");
  process.exit(1);
}
const { run } = await import(built);

process.exitCode = await run(process.argv.slice(2), {
  io: { out: console.log, err: console.error },
  cwd: process.cwd(),
  env: process.env,
});
