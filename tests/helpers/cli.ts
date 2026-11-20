import { buildProgram, runProgram, type ProgramOptions } from '../../packages/cli/src/program.js';

/** A machine with OpenCode 2 and no other tool, so no test depends on what is installed. */
const fakeOpencode = (command: string): string => {
  if (command === 'opencode') return 'opencode v2.2.5\n';
  throw new Error(`${command}: not found`);
};

/** Runs the CLI in-process with the given options and returns what it printed. */
export async function runCli(opts: ProgramOptions, args: string[]): Promise<{ out: string; err: string; code: typeof process.exitCode }> {
  let out = '';
  let err = '';
  const program = buildProgram({ env: {}, tool: fakeOpencode, pdf: { find: () => undefined }, ...opts, stdout: (s) => (out += s), stderr: (s) => (err += s) });
  await runProgram(program, args, 'user');
  return { out, err, code: process.exitCode };
}
