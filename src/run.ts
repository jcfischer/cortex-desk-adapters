/** Runs argv without a shell, with optional stdin. Injected so tests never reach soma, GitHub, a model or the goal records. */
export type Runner = (argv: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnRunner: Runner = async (argv, stdin) => {
  const proc = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

/** The last non-empty line of a command's output, e.g. a failed command's stderr for a refusal sentence. */
export const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim() ?? "";
