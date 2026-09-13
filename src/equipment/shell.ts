import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineEquipment } from "./registry.js";

const exec = promisify(execFile);

/** The commands `run_readonly` may run; anything else is refused before it starts. */
export const READ_ONLY_COMMANDS = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "stat",
] as const;

export const runReadonlyEquipment = defineEquipment({
  name: "run_readonly",
  description: `Run one allowlisted read-only command (${READ_ONLY_COMMANDS.join(", ")}) and return its output`,
  input: z.object({
    command: z.enum(READ_ONLY_COMMANDS),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1),
    timeoutSeconds: z.number().positive().default(30),
  }),
  output: z.object({
    command: z.string(),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  cost: { typicalSeconds: 0.05 },
  run: async ({ command, args, cwd, timeoutSeconds }) => {
    try {
      const { stdout, stderr } = await exec(command, args, {
        cwd,
        timeout: timeoutSeconds * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { command, exitCode: 0, stdout, stderr };
    } catch (error) {
      const e = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      return {
        command,
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(error),
      };
    }
  },
});
