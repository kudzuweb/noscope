export const VERSION = "0.0.1";

export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
};

type Command = {
  name: string;
  usage: string;
  summary: string;
  arrives: string;
};

export const INCIDENT_COMMANDS: readonly Command[] = [
  {
    name: "create",
    usage:
      'create "<objective>" [--constraint ...] [--priority ...] [--budget ...]',
    summary: "Create an incident and its root unit, command",
    arrives: "PR 4",
  },
  {
    name: "show",
    usage: "show <id>",
    summary: "Print the incident file",
    arrives: "PR 4",
  },
  {
    name: "events",
    usage: "events <id>",
    summary: "Print the event log",
    arrives: "PR 4",
  },
  {
    name: "tree",
    usage: "tree <id>",
    summary: "Print the unit tree with task marks",
    arrives: "PR 11",
  },
  {
    name: "step",
    usage: "step <id>",
    summary: "Run one cycle and stop",
    arrives: "PR 12",
  },
  {
    name: "answer",
    usage: 'answer <id> "<text>"',
    summary: "Answer the planner's open question and reopen the incident",
    arrives: "PR 13",
  },
  {
    name: "run",
    usage: "run <id> [--max-cycles N]",
    summary: "Repeat step until the incident leaves open or the cap is hit",
    arrives: "PR 14",
  },
];

export function helpText(): string {
  const width = Math.max(...INCIDENT_COMMANDS.map((c) => c.usage.length));
  const lines = INCIDENT_COMMANDS.map(
    (c) => `  noscope incident ${c.usage.padEnd(width)}  ${c.summary}`,
  );
  return [
    `noscope ${VERSION}`,
    "",
    "An agent runtime built on the Incident Command System as its primitive.",
    "",
    "Usage:",
    "  noscope --help",
    "  noscope --version",
    ...lines,
    "",
    "Commands print the PR that delivers them until they are implemented.",
  ].join("\n");
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [first, second] = argv;
  if (
    first === undefined ||
    first === "--help" ||
    first === "-h" ||
    first === "help"
  ) {
    io.out(helpText());
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(VERSION);
    return 0;
  }
  if (first === "incident") {
    if (
      second === undefined ||
      second === "--help" ||
      second === "-h" ||
      second === "help"
    ) {
      io.out(helpText());
      return 0;
    }
    const command = INCIDENT_COMMANDS.find((c) => c.name === second);
    if (command === undefined) {
      io.err(
        `noscope incident: unknown command ${JSON.stringify(second ?? "")}`,
      );
      io.err(helpText());
      return 2;
    }
    io.err(
      `noscope incident ${command.name}: not yet implemented, arrives in ${command.arrives}`,
    );
    return 3;
  }
  io.err(`noscope: unknown command ${JSON.stringify(first)}`);
  io.err(helpText());
  return 2;
}
