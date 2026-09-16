import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listCapabilities } from "./capabilities/index.js";
import {
  BUILTIN_TOOLS,
  listEquipment,
  listExternalEquipment,
  READ_ONLY_SESSION_COMMANDS,
} from "./equipment/index.js";
import {
  type Incident,
  IncidentBriefing,
  jsonSchemaFor,
  type Usage,
} from "./models.js";
import {
  getProvider,
  type Provider,
  type SessionActivity,
  sessionSystemPrompt,
} from "./providers/index.js";

// The initial IC (R3-8): a cheap session that sizes the incident up when it is created and
// hands command over with the incident briefing, the first handoff document. The runtime
// gathers what it can check itself before the session runs and renders it into the prompt,
// so the session spends its bound on judgment rather than on `ls` (DESIGN.md Step 4).

/** The model the size-up runs on unless `create --initial-model` names another. */
export const INITIAL_MODEL = "claude-haiku-4-5";

/** The size-up is one call with tools, bounded like a turn. */
const SIZE_UP_SECONDS = 300;
const GIT_TIMEOUT_MS = 10_000;
const URL_TIMEOUT_MS = 5_000;

const exec = promisify(execFile);
const SIZE_UP_SCHEMA = jsonSchemaFor(IncidentBriefing);

/** The role text as the initial IC reads it: size up, brief, hand over; decide nothing that lasts. */
export const INITIAL_IC_ROLE = `Your role: initial Incident Commander. You are the first session on this incident and you hold command only until the briefing is written. Size the incident up: read what the objective points at, check what a tool of yours can check, and write the incident briefing on ICS 201's lines: what sort of incident this is, the one problem it turns on, what is obviously needed and whether you checked it, the objectives for the first operational period, an initial organization sketched one unit per line with the model its leader should be on, the questions only Mauria can answer, the hazards, and the incoming commander: the provider and model the Incident Commander proper should run on, and why.

A check is one look at whether a thing exists, answers, or is where the objective says it is; what the incident turns on is for the units to establish under the Incident Commander, not for you to read your way to. Recommend the commander by the judgment the incident needs, not by habit: a narrow, well-marked read is Haiku's or Sonnet's; a build, a subtle investigation or anything that turns on weighing evidence is Opus's; say which and why. Every model the provider serves is listed in your prompt; name one of those. Your recommendation is recorded on the transfer of command for the Incident Commander to read and does not route it: the Incident Commander runs on Sonnet 5 unless the operator named another model when the incident was created.

The objectives, the units and the questions follow from the kind of incident, and the kind follows from the objective's verb. An objective that asks to determine, identify, explain or find, or asks a question (where, what, why), is a diagnosis, answered by the cause or the place it names: it takes no fix objective, no fix unit and no question about what the intended behavior should be, because the answer is the cause, and the fix is another incident unless the objective asks for it. An objective that asks to build, change, fix or add is a build and takes those: an objective for the change, a unit to make it, and the question of intended behavior where the objective leaves it open.

A question for Mauria blocks the incident until she answers, so ask only what no tool could find and the objective does not already settle: what only she knows or may decide. Say what you saw and what you think, plainly, and keep them apart: the Incident Commander who takes command evaluates every line of your briefing and may accept, rewrite or discard it. Your tools are read-only; you change nothing and you assign nothing.`;

/** What the runtime checked before the size-up ran, rendered into the initial IC's prompt and recorded on `incident.briefed`. */
export type SizeUpFindings = {
  capabilities: string[];
  equipment: string[];
  budget: string;
  cwd: string;
  git: string;
  urls: { url: string; answers: string }[];
  providers: string[];
};

/** Whether the working directory is inside a git repository, and its state when it is. */
async function gitState(cwd: string): Promise<string> {
  const git = async (args: string[]) =>
    (
      await exec("git", args, {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4_000_000,
      })
    ).stdout.trim();
  try {
    const root = await git(["rev-parse", "--show-toplevel"]);
    // `symbolic-ref` names the branch before any commit exists; it fails on a detached HEAD.
    const branch = await git(["symbolic-ref", "--short", "HEAD"]).catch(
      () => "detached HEAD",
    );
    const head = await git(["rev-parse", "--short", "HEAD"]).catch(
      () => "no commits",
    );
    const status = await git(["status", "--porcelain"]);
    const changed = status === "" ? 0 : status.split("\n").length;
    return `a git repository at ${root}, branch ${branch}, HEAD ${head}, ${changed} changed path(s)`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /not a git repository/i.test(message)
      ? "not a git repository"
      : `git could not report: ${message.split("\n")[0]}`;
  }
}

/** Whether a URL answers: one request with a short timeout, HEAD first, GET when the server refuses HEAD. */
async function urlAnswers(url: string): Promise<string> {
  const request = (method: "HEAD" | "GET") =>
    fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    });
  try {
    let response = await request("HEAD");
    if (response.status === 405 || response.status === 501)
      response = await request("GET");
    return `answers (HTTP ${response.status})`;
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : error instanceof Error
          ? error.message
          : String(error);
    return `does not answer: ${cause}`;
  }
}

/** Every URL the constraints name, once each, in order. */
export function urlsIn(constraints: readonly string[]): string[] {
  const found = new Set<string>();
  for (const c of constraints)
    for (const m of c.matchAll(/https?:\/\/[^\s"'<>)\]]+/g))
      found.add(m[0].replace(/[.,;:]+$/, ""));
  return [...found];
}

/**
 * The runtime's own deterministic findings, gathered in code before the size-up session
 * runs: the registered capabilities and equipment, the budget, whether the working
 * directory is a git repository and its state, whether each URL a constraint names
 * answers, and the models each provider serves.
 */
export async function gatherFindings(
  incident: Incident,
  cwd: string,
  providers: readonly Provider[],
): Promise<SizeUpFindings> {
  const urls = await Promise.all(
    urlsIn(incident.constraints).map(async (url) => ({
      url,
      answers: await urlAnswers(url),
    })),
  );
  return {
    capabilities: listCapabilities().map(
      (c) => `${c.name} [${c.kind}, ${c.effect}]: ${c.description}`,
    ),
    equipment: [
      `built-in tools: ${BUILTIN_TOOLS.join(", ")} (Bash under the read-only allowlist: ${READ_ONLY_SESSION_COMMANDS.join(", ")})`,
      ...listEquipment().map((e) => `${e.name}: ${e.description}`),
      ...listExternalEquipment().map((e) => `${e.name}: ${e.description}`),
    ],
    budget: `tokens ${incident.budget.tokens ?? "unlimited"}, seconds ${incident.budget.seconds ?? "unlimited"}`,
    cwd,
    git: await gitState(cwd),
    urls,
    providers: providers.map((p) => `${p.name}: ${p.models.join(", ")}`),
  };
}

function bullets(items: readonly string[], empty = "(none)"): string[] {
  return items.length === 0 ? [`  ${empty}`] : items.map((i) => `  - ${i}`);
}

/** The initial IC's user message: the incident as Mauria gave it, what the runtime checked, and the ask. */
export function renderSizeUpPrompt(
  incident: Incident,
  findings: SizeUpFindings,
): string {
  return [
    "# Size-up",
    `Incident objective: ${incident.objective}`,
    "constraints:",
    ...bullets(incident.constraints),
    "priorities:",
    ...bullets(incident.priorities),
    `budget: ${findings.budget}`,
    "",
    "# What the runtime checked",
    `working directory: ${findings.cwd}`,
    `git: ${findings.git}`,
    "URLs the constraints name:",
    ...bullets(findings.urls.map((u) => `${u.url}: ${u.answers}`)),
    "capabilities registered, which the planner tasks:",
    ...bullets(findings.capabilities),
    "equipment registered:",
    ...bullets(findings.equipment),
    "providers and models the Incident Commander may run on:",
    ...bullets(findings.providers),
    "",
    "# Your briefing",
    `Size the incident up with your tools within ${SIZE_UP_SECONDS} seconds, then write the incident briefing: kind, dominantProblem, obviouslyNeeded (each with whether you checked it and what the check showed), initialObjectives and initialOrganization (one unit per line, with its leader's model) scoped to the objective's verb, questionsForHuman (only what no tool could find and the objective does not settle), hazards, and incomingCommander with why. The runtime's findings above are checked; cite them rather than re-checking.`,
  ].join("\n");
}

/** What the size-up came to: the session's raw output (parsed by the caller, so a briefing that does not fit is still filed with its call), the call's provenance, and the findings it read. */
export type SizeUp = {
  output: unknown;
  sessionId: string;
  usage: Usage;
  activity: SessionActivity;
  findings: SizeUpFindings;
};

export type SizeUpOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  provider: string;
  model: string;
  providers: readonly Provider[];
};

/**
 * Run the size-up: one session on the initial model with the read-only tool set (the four
 * built-ins, Bash under the read-only allowlist), bounded, whose output is meant to be an
 * `IncidentBriefing`. Throws the provider's `SessionError`; the output comes back unparsed,
 * so the caller parses it and files a session whose answer does not fit as `command.failed`
 * with its usage and activity, the way `icCall` files an IC turn.
 */
export async function sizeUp(
  incident: Incident,
  options: SizeUpOptions,
): Promise<SizeUp> {
  const findings = await gatherFindings(
    incident,
    options.cwd,
    options.providers,
  );
  const provider = getProvider(options.provider, options.env);
  const outcome = await provider.run({
    model: options.model,
    systemPrompt: sessionSystemPrompt(INITIAL_IC_ROLE, "initial_ic"),
    prompt: renderSizeUpPrompt(incident, findings),
    tools: [...BUILTIN_TOOLS],
    mcpServers: [],
    integrations: [],
    bashAllowlist: [...READ_ONLY_SESSION_COMMANDS],
    cwd: options.cwd,
    addDirs: [],
    outputSchema: SIZE_UP_SCHEMA,
    timeoutSeconds: SIZE_UP_SECONDS,
  });
  return {
    output: outcome.output,
    sessionId: outcome.sessionId,
    usage: outcome.usage,
    activity: outcome.activity,
    findings,
  };
}
