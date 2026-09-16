import { z } from "zod";
import { resolveEquipment } from "../capabilities/index.js";
import type { RefusedCall } from "../leader.js";
import type {
  Claim,
  Event,
  Incident,
  LeaderReport,
  ResourceRequest,
  Task,
  TaskProposal,
  Unit,
} from "../models.js";
import {
  type Provider,
  type Seat,
  type SessionRequest,
  sessionSystemPrompt,
} from "../providers/index.js";
import type { Store } from "../store.js";

// A unit is a type plus a config (R4-10, ruled 2026-09-15). The type is the form, the
// fields a kind of unit fills, and the protocol, how a unit of that kind uses what is in the
// box; the config is the filled form, the values chosen for one incident. `base` is the led
// unit and `ic` is command, the root; a config keeps its type's protocol, since it occupies
// the same place in the hierarchy and reports the same way. Types are registered here by
// name, as capabilities are in `src/capabilities/registry.ts`, so more can be written.

/** How a task ended, for the leader's next turn: completed, with the claims it produced; failed with the reason and the tasks cancelled because they waited on it (R5-10, `settled`); or cancelled because a task it waited on will never complete (`because`, the task at the root of the chain, and the reason), which only reaches a leader as an ending it has not heard. */
export type TaskEnding =
  | { task: Task; status: "completed"; claims: readonly Claim[] }
  | { task: Task; status: "failed"; reason: string; settled: readonly string[] }
  | { task: Task; status: "cancelled"; because: string; reason: string };

/** An ending as it lands in a pass: the task's ending, and the refusals when its session was refused on both models (R4-7), for the unit's report. */
export type Landed = TaskEnding & { refusals?: readonly RefusedCall[] };

/** A report a unit filed during the pass; the session is null when the runtime wrote it on the leader's behalf after two refusals (R4-7); `revision` is set when the report answers a revise verdict (R4-3). */
export type Reported = {
  unitId: string;
  sessionId: string | null;
  report: LeaderReport;
  revision?: number;
};

/**
 * What a protocol's turn came to: the unit as it now stands (its session recorded, its
 * leader changed by a fallback), the report it filed if any, whether the unit is done for
 * the pass, and whether the report changed the picture, which halts the pass.
 */
export type Turned = {
  unit: Unit;
  report: Reported | null;
  done: boolean;
  stop: boolean;
};

/**
 * What the dispatcher lends a protocol for a unit's pass: the store and the incident, the
 * active units in tree order (the hierarchy a leader reads), where and as whom it runs,
 * and the runtime's bookkeeping around a turn. The bookkeeping is lent rather than
 * imported so that a protocol module depends on neither the validator nor the runtime,
 * which depend on the registry.
 */
export type PassContext = {
  store: Store;
  incident: Incident;
  units: readonly Unit[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  actor: string;
  /** The providers a leader's assignments are validated against; Claude Code alone when absent, as a plan's are. */
  providers?: readonly Provider[];
  bookkeeping: {
    /** Validate a leader's assignments and record the verdict; true when they may be applied. */
    validateAssignments: (
      unit: Unit,
      tasks: readonly TaskProposal[],
    ) => boolean;
    /** Apply validated assignments under the unit; the number created. */
    applyAssignments: (unit: Unit, tasks: readonly TaskProposal[]) => number;
    /** Raise a report's resource requests: the unit waits. */
    raiseRequests: (unit: Unit, requests: readonly ResourceRequest[]) => void;
  };
};

/**
 * What a protocol sees of the dispatcher's pass around a turn: the unit's runnable tasks
 * not yet attempted, the endings of earlier passes its leader has not heard (given once),
 * the tasks still running in sessions of their own, the endings landed and not yet heard,
 * whether the unit ran anything this pass, whether it is done, and whether the pass has
 * halted (nothing new starts). The unit itself is the hook's argument: no task runs on the
 * leader's session (R5-4), so only a turn changes the unit, and the turns run one after
 * another in the pass's loop.
 */
export type PassView = {
  remaining: () => Task[];
  hear: () => readonly TaskEnding[];
  running: () => Task[];
  landed: () => Task[];
  ran: () => boolean;
  done: () => boolean;
  halted: () => boolean;
};

/** What an assignment rule reads beyond the assignments and the unit: the incident's tasks and log, for the unit's share of the budget. */
export type AssignmentContext = {
  tasks: readonly Task[];
  events: readonly Event[];
};

/**
 * A rule a type holds its leader's assignments to beyond the plan's task rules (DESIGN.md
 * Step 5): the line the role text lists, whose name before the colon keys the validator's
 * rejection, and the check, which returns the reasons the assignments fail it.
 */
export type AssignmentRule<N extends string = string> = {
  name: N;
  text: `${N}: ${string}`;
  check: (
    tasks: readonly TaskProposal[],
    unit: Unit,
    ctx: AssignmentContext,
  ) => string[];
};

/** An assignment rule from its line and its check; the name is the text before the colon, so the two cannot drift. */
export function assignmentRule<N extends string>(
  text: `${N}: ${string}`,
  check: AssignmentRule["check"],
): AssignmentRule<N> {
  return { name: text.slice(0, text.indexOf(":")) as N, text, check };
}

/** The rule every type shares: a leader assigns under its own unit, and nowhere else. */
export const OWN_UNIT_RULE = assignmentRule(
  "Own unit: every task you assign names your own unit as its unit; no new units, no tasks under another unit.",
  (tasks, unit) =>
    tasks
      .filter((t) => t.unit !== unit.id)
      .map(
        (t) =>
          `task "${t.objective}" is under ${t.unit}, not the leader's own unit ${unit.id}`,
      ),
);

/**
 * How a unit of a type uses what is in the box: the seat its session holds (the system
 * prompt's place), the role text its session reads when the config carries none, whether
 * the unit files reports the IC answers with verdicts (command does not: its tasks'
 * results are judged at the command turn, R4-6), the rules its leader's assignments are
 * held to beyond the plan's task rules, whether the unit has a turn to take this pass
 * beyond its runnable tasks (`hasWork`: a brief to read, answers, a report owed; the
 * dispatcher starts a pass
 * on it or on a runnable task), the endings of earlier passes its leader has not heard
 * (`unheard`, which ride on the pass's first turn), and the turns the unit takes around
 * its tasks in a pass:
 * `open` before any task starts (a revision brief, the answers to its requests), `ending`
 * on each task ending that lands (the leader's turn on it; the runtime's report after two
 * refusals), and `close` once every run has landed (the report owed from an earlier pass;
 * for command, nothing, the pass ending with its tasks). Each returns what the turn came
 * to, or null when the protocol takes no turn there. No task ever runs on a unit's
 * session, whatever its type (R5-4): a session task runs in a session of its own, a
 * deterministic one in process, and either's result reaches the protocol as an ending.
 */
export type Protocol = {
  seat: Seat;
  role: string;
  reports: boolean;
  rules: readonly AssignmentRule[];
  hasWork: (ctx: PassContext, unit: Unit) => boolean;
  unheard: (ctx: PassContext, unit: Unit) => TaskEnding[];
  open: (
    ctx: PassContext,
    unit: Unit,
    view: PassView,
  ) => Promise<Turned | null>;
  ending: (
    ctx: PassContext,
    unit: Unit,
    ending: Landed,
    view: PassView,
  ) => Promise<Turned | null>;
  close: (
    ctx: PassContext,
    unit: Unit,
    view: PassView,
  ) => Promise<Turned | null>;
};

/**
 * A unit type: its name, the form (a zod object of the fields a config of the type fills,
 * every one carrying a `role` field for the role text, with descriptions the planner's
 * schema renders), whether a plan may create a unit of the type (the led unit yes; command
 * no, since the runtime creates it with the incident), and the protocol.
 */
export type UnitType<F extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  plannable: boolean;
  form: F;
  protocol: Protocol;
};

const registry = new Map<string, UnitType>();

export function defineUnitType<F extends z.ZodObject>(
  spec: UnitType<F>,
): UnitType<F> {
  if (registry.has(spec.name))
    throw new Error(`unit type ${spec.name} is already registered`);
  if (!("role" in spec.form.shape))
    throw new Error(
      `unit type ${spec.name} must carry the role text as a form field named role`,
    );
  registry.set(spec.name, spec as unknown as UnitType);
  return spec;
}

export function getUnitType(name: string): UnitType | undefined {
  return registry.get(name);
}

export function listUnitTypes(): UnitType[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The protocol a unit runs under: its type's; a unit naming no registered type is refused, since nothing could run it. */
export function protocolOf(unit: Unit): Protocol {
  const type = registry.get(unit.type);
  if (type === undefined)
    throw new Error(
      `unit ${unit.id} names no registered unit type ${unit.type}`,
    );
  return type.protocol;
}

/** The role text a unit's session reads: the config's own when it carries one, else its type's. */
export function roleOf(unit: Unit): string {
  return unit.role ?? protocolOf(unit).role;
}

/** A reason in one sentence: a schema failure names its issues rather than dumping them. */
export function describeError(error: unknown): string {
  if (error instanceof z.ZodError)
    return `the result did not fit its schema: ${error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

/** A turn is one structured call with no task of its own; it gets the planner's bound. */
const LEADER_TURN_SECONDS = 300;

/** What a leader session holds: nothing by default, since a turn is decided from what is in front of it (R5-4); the ic type passes its form's equipment. */
export type LeaderTools = {
  equipment: readonly string[];
  bashAllowlist: readonly string[];
};

const NO_TOOLS: LeaderTools = { equipment: [], bashAllowlist: [] };

/**
 * A call on the unit's leader session: the leader's model, the seat's system prompt under
 * the unit's role text (kept from the first call when the session is resumed), the unit's
 * session to resume once it has one, and the tools the session holds: none unless the
 * caller names them, since a leader directs and never does (R5-4; `--tools ""` disables
 * every built-in on Claude Code 2.1.273).
 */
export function leaderRequest(
  unit: Unit,
  prompt: string,
  outputSchema: Record<string, unknown>,
  cwd: string,
  timeoutSeconds = LEADER_TURN_SECONDS,
  tools: LeaderTools = NO_TOOLS,
): SessionRequest {
  return {
    model: unit.leader.model,
    systemPrompt: sessionSystemPrompt(roleOf(unit), protocolOf(unit).seat),
    prompt,
    ...resolveEquipment(tools.equipment),
    bashAllowlist: tools.bashAllowlist,
    cwd,
    addDirs: [],
    outputSchema,
    timeoutSeconds,
    ...(unit.sessionId === null ? {} : { resume: unit.sessionId }),
  };
}
