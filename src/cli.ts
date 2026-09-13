import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;

export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type Context = {
  io: Io;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type Handler = (
  positionals: readonly string[],
  ctx: Context,
) => Promise<number>;

export type Command = {
  group: "incident" | "top";
  name: string;
  usage: string;
  summary: string;
  arrives: string;
  handler?: Handler | undefined;
};

export const EXIT = {
  ok: 0,
  usage: 2,
  notYetImplemented: 3,
} as const;

export const COMMANDS: readonly Command[] = [
  {
    group: "incident",
    name: "create",
    usage:
      'incident create "<objective>" [--constraint ...] [--priority ...] [--budget ...]',
    summary: "Create an incident and its root unit, command",
    arrives: "PR 4",
  },
  {
    group: "incident",
    name: "show",
    usage: "incident show <id>",
    summary: "Print the incident file",
    arrives: "PR 4",
  },
  {
    group: "incident",
    name: "events",
    usage: "incident events <id>",
    summary: "Print the event log",
    arrives: "PR 4",
  },
  {
    group: "incident",
    name: "tree",
    usage: "incident tree <id>",
    summary: "Print the unit tree with task marks",
    arrives: "PR 11",
  },
  {
    group: "incident",
    name: "step",
    usage: "incident step <id>",
    summary: "Run one cycle and stop",
    arrives: "PR 12",
  },
  {
    group: "incident",
    name: "answer",
    usage: 'incident answer <id> "<text>"',
    summary: "Answer the planner's open question and reopen the incident",
    arrives: "PR 13",
  },
  {
    group: "incident",
    name: "run",
    usage: "incident run <id> [--max-cycles N]",
    summary: "Repeat step until the incident leaves open or the cap is hit",
    arrives: "PR 14",
  },
  {
    group: "incident",
    name: "sop",
    usage: "incident sop <id> <name>",
    summary:
      "Add an SOP's unit and its tasks to the incident in one action plan",
    arrives: "after v0",
  },
  {
    group: "incident",
    name: "grant",
    usage: "incident grant <id> <capability> [--per-task]",
    summary: "Give a grant for one capability on this incident",
    arrives: "after v0",
  },
  {
    group: "top",
    name: "grant",
    usage: "grant standing <capability>",
    summary: "Whitelist a capability everywhere",
    arrives: "after v0",
  },
];

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));
  const rows = COMMANDS.map(
    (c) => `  noscope ${c.usage.padEnd(width)}  ${c.summary}`,
  );
  const pending = COMMANDS.some((c) => c.handler === undefined);
  return [
    `noscope ${VERSION}`,
    "",
    "An agent runtime built on the Incident Command System as its primitive.",
    "",
    "Usage:",
    "  noscope --help",
    "  noscope --version",
    ...rows,
    ...(pending
      ? [
          "",
          `Commands not built yet print what delivers them and exit ${EXIT.notYetImplemented}.`,
        ]
      : []),
  ].join("\n");
}

function notYetImplemented(command: Command): Handler {
  const label =
    command.group === "incident" ? `incident ${command.name}` : command.name;
  return async (_positionals, ctx) => {
    ctx.io.err(
      `noscope ${label}: not yet implemented, arrives ${command.arrives}`,
    );
    return EXIT.notYetImplemented;
  };
}

function findCommand(positionals: readonly string[]): Command | undefined {
  const [first, second] = positionals;
  if (first === "incident") {
    return COMMANDS.find((c) => c.group === "incident" && c.name === second);
  }
  return COMMANDS.find((c) => c.group === "top" && c.name === first);
}

export async function run(
  argv: readonly string[],
  ctx: Context,
): Promise<number> {
  const { io } = ctx;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: false,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        v: { type: "boolean" },
      },
    });
  } catch (error) {
    io.err(
      `noscope: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.usage;
  }
  const positionals = parsed.positionals;
  if (parsed.values.version === true || parsed.values.v === true) {
    io.out(VERSION);
    return EXIT.ok;
  }
  const wantsHelp =
    parsed.values.help === true ||
    positionals.length === 0 ||
    positionals[0] === "help" ||
    (positionals[0] === "incident" &&
      (positionals.length === 1 || positionals[1] === "help"));
  if (wantsHelp) {
    io.out(helpText());
    return EXIT.ok;
  }
  const command = findCommand(positionals);
  if (command === undefined) {
    io.err(
      `noscope: unknown command ${JSON.stringify(positionals.slice(0, 2).join(" "))}`,
    );
    io.err(helpText());
    return EXIT.usage;
  }
  const rest =
    command.group === "incident" ? positionals.slice(2) : positionals.slice(1);
  return (command.handler ?? notYetImplemented(command))(rest, ctx);
}
