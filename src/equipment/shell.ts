import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { READ_ONLY_COMMANDS } from "./builtin.js";
import { defineEquipment } from "./registry.js";

const exec = promisify(execFile);

/**
 * Arguments that turn an allowlisted command into a writer. `find` is the one command on the
 * list whose primaries act on the tree: `-delete` removes, `-exec` and its variants run
 * anything, and the `-f*` family writes files.
 */
const FORBIDDEN_ARGS: Partial<
  Record<(typeof READ_ONLY_COMMANDS)[number], readonly string[]>
> = {
  find: [
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
  ],
};

export const runReadonlyEquipment = defineEquipment({
  name: "run_readonly",
  description: `Run one allowlisted read-only command (${READ_ONLY_COMMANDS.join(", ")}) and return its output`,
  input: z
    .object({
      command: z.enum(READ_ONLY_COMMANDS),
      args: z.array(z.string()).default([]),
      cwd: z.string().min(1),
      timeoutSeconds: z.number().positive().default(30),
      maxBytes: z.number().int().positive().default(200_000),
    })
    .superRefine((input, ctx) => {
      const forbidden = FORBIDDEN_ARGS[input.command] ?? [];
      for (const [i, arg] of input.args.entries()) {
        if (forbidden.includes(arg)) {
          ctx.addIssue({
            code: "custom",
            path: ["args", i],
            message: `${input.command} ${arg} is not read-only`,
          });
        }
      }
    }),
  output: z.object({
    command: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    failure: z.enum(["timeout", "output_too_large"]).nullable(),
  }),
  cost: { typicalSeconds: 0.05 },
  run: async ({ command, args, cwd, timeoutSeconds, maxBytes }) => {
    try {
      const { stdout, stderr } = await exec(command, args, {
        cwd,
        timeout: timeoutSeconds * 1000,
        maxBuffer: maxBytes,
      });
      return { command, exitCode: 0, stdout, stderr, failure: null };
    } catch (error) {
      const e = error as {
        code?: number | string | null;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      const failure =
        e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? ("output_too_large" as const)
          : e.killed === true
            ? ("timeout" as const)
            : null;
      if (failure === null && typeof e.code !== "number") throw error;
      const reason =
        failure === "timeout"
          ? `${command} was killed after ${timeoutSeconds}s`
          : failure === "output_too_large"
            ? `${command} produced more than ${maxBytes} bytes of output`
            : "";
      return {
        command,
        exitCode: typeof e.code === "number" ? e.code : null,
        stdout: e.stdout ?? "",
        stderr: e.stderr === undefined || e.stderr === "" ? reason : e.stderr,
        failure,
      };
    }
  },
});
