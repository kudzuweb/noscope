export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type Context = {
  io: Io;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** A command handler receives the arguments after the command words, unparsed. */
export type Handler = (
  args: readonly string[],
  ctx: Context,
) => Promise<number>;

/** Exit codes, DESIGN.md Step 7. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  notYetImplemented: 3,
  notFound: 4,
  cannotProceed: 5,
} as const;
