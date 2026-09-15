import { createRequire } from "node:module";
import * as config from "./commands/config.js";
import * as incident from "./commands/incident.js";
import { type Context, EXIT, type Handler } from "./context.js";

export { type Context, EXIT, type Handler, type Io } from "./context.js";

const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;

export type Command = {
  group: "incident" | "config" | "top";
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
      'incident create "<objective>" [--constraint ...] [--priority ...] [--budget-tokens N] [--budget-seconds N] [--ic-model <model>]',
    summary:
      "Create an incident and its root unit, command, whose leader is the Incident Commander",
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
    summary:
      "Answer the oldest open question, the planner's or a unit leader's; a unit's question answered returns the unit to active, the planner's reopens the incident",
    arrives: "PR 13",
    handler: incident.answer,
  },
  {
    group: "incident",
    name: "provide",
    usage: 'incident provide <id> "<text>"',
    summary:
      "Answer the oldest open capability request, the planner's or a unit leader's, with what was provided, or why not; a unit's answered returns the unit to active, the planner's reopens the incident",
    arrives: "PR 27",
    handler: incident.provide,
  },
  {
    group: "incident",
    name: "run",
    usage: "incident run <id> [--max-cycles N]",
    summary: "Repeat step until the incident leaves open or the cap is hit",
    arrives: "PR 14",
    handler: incident.run,
  },
  {
    group: "incident",
    name: "review",
    usage: "incident review <id>",
    summary:
      "The After Action Review from the log: each cycle, every run, totals by model, cost",
    arrives: "PR 19",
    handler: incident.review,
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
    group: "config",
    name: "save",
    usage: "config save <incident> <unit-id> <name>",
    summary:
      "Save a unit's filled form (its type, leader, equipment, Bash allowlist and role text) under a name a plan deploys it by",
    arrives: "R4-11",
    handler: config.save,
  },
  {
    group: "config",
    name: "list",
    usage: "config list",
    summary: "List the saved unit configs with their fields",
    arrives: "R4-11",
    handler: config.list,
  },
  {
    group: "config",
    name: "show",
    usage: "config show <name>",
    summary: "Print one saved unit config in full",
    arrives: "R4-11",
    handler: config.show,
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
    command.group === "top" ? command.name : `${command.group} ${command.name}`;
  return async (_args, ctx) => {
    ctx.io.err(
      `noscope ${label}: not yet implemented, arrives ${command.arrives}`,
    );
    return EXIT.notYetImplemented;
  };
}

function findCommand(words: readonly string[]): Command | undefined {
  const [first, second] = words;
  if (first === "incident" || first === "config")
    return COMMANDS.find((c) => c.group === first && c.name === second);
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
    ((words[0] === "incident" || words[0] === "config") &&
      (words.length === 1 || words[1] === "help"));
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
  const rest = afterCommandWords(argv, command.group === "top" ? 1 : 2);
  return (command.handler ?? notYetImplemented(command))(rest, ctx);
}
