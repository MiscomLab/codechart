import type { CommandOptions } from '../program.js';
import { copyFiles as copyFilesCore, hasAny, installPairs as installPairsCore, sameFile, type InstallIO, type Pair } from '@codechart/core';

export { hasAny, sameFile };
export type { Pair };

/** The CLI's side of the installer: its output streams, and a failed step sets a non-zero exit code. */
export const installIO = (opts: CommandOptions): InstallIO => ({
  stdout: (s) => opts.stdout(s),
  stderr: (s) => opts.stderr(s),
  failed: () => {
    process.exitCode = 1;
  },
});

export const copyFiles = (pairs: Pair[], force: boolean, opts: CommandOptions): boolean => copyFilesCore(pairs, force, installIO(opts));

export const installPairs = (pairs: Pair[], where: string, who: string, ours: () => boolean, force: boolean, opts: CommandOptions): boolean =>
  installPairsCore(pairs, where, who, ours, force, installIO(opts));
