import { createRequire } from "node:module";
import * as incident from "./commands/incident.js";
import { type Context, EXIT, type Handler } from "./context.js";

export { type Context, EXIT, type Handler, type Io } from "./context.js";

const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;

export type Command = {
  group: "incident" | "top";
  name: string;
  usage: string;
  summary: string;
  arrives: string;
  handler?: Handler | undefined;
};

export const COMMANDS: readonly Command[] = [
  {
    group: "incident",
    name: "create",
    usage:
      'incident create "<objective>" [--constraint ...] [--priority ...] [--budget-tokens N] [--budget-seconds N]',
    summary: "Create an incident and its root unit, command",
    arrives: "PR 4",
    handler: incident.create,
  },
  {
    group: "incident",
    name: "show",
    usage: "incident show <id>",
    summary: "Print the incident file",
    arrives: "PR 4",
    handler: incident.show,
  },
  {
    group: "incident",
    name: "events",
    usage: "incident events <id>",
    summary: "Print the event log",
    arrives: "PR 4",
    handler: incident.events,
  },
  {
    group: "incident",
    name: "tree",
    usage: "incident tree <id>",
    summary: "Print the unit tree with task marks",
    arrives: "PR 11",
    handler: incident.tree,
  },
  {
    group: "incident",
    name: "step",
    usage: "incident step <id>",
    summary: "Run one cycle and stop",
    arrives: "PR 12",
    handler: incident.step,
  },
  {
    group: "incident",
    name: "answer",
    usage: 'incident answer <id> "<text>"',
    summary: "Answer the planner's open question and reopen the incident",
    arrives: "PR 13",
    handler: incident.answer,
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
  return async (_args, ctx) => {
    ctx.io.err(
      `noscope ${label}: not yet implemented, arrives ${command.arrives}`,
    );
    return EXIT.notYetImplemented;
  };
}

function findCommand(words: readonly string[]): Command | undefined {
  const [first, second] = words;
  if (first === "incident")
    return COMMANDS.find((c) => c.group === "incident" && c.name === second);
  return COMMANDS.find((c) => c.group === "top" && c.name === first);
}

/** Everything after the command words, flags included, in the order given. */
function afterCommandWords(argv: readonly string[], count: number): string[] {
  const out: string[] = [];
  let seen = 0;
  for (const a of argv) {
    if (seen < count && !a.startsWith("-")) {
      seen += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function run(
  argv: readonly string[],
  ctx: Context,
): Promise<number> {
  const { io } = ctx;
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V") {
    io.out(VERSION);
    return EXIT.ok;
  }
  const words = argv.filter((a) => !a.startsWith("-"));
  const wantsHelp =
    argv.some((a) => a === "--help" || a === "-h") ||
    words.length === 0 ||
    words[0] === "help" ||
    (words[0] === "incident" && (words.length === 1 || words[1] === "help"));
  if (wantsHelp) {
    io.out(helpText());
    return EXIT.ok;
  }
  const command = findCommand(words);
  if (command === undefined) {
    io.err(
      `noscope: unknown command ${JSON.stringify(words.slice(0, 2).join(" "))}`,
    );
    io.err(helpText());
    return EXIT.usage;
  }
  const rest = afterCommandWords(argv, command.group === "incident" ? 2 : 1);
  return (command.handler ?? notYetImplemented(command))(rest, ctx);
}
