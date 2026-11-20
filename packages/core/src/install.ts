import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isCodechartSkill } from './agents.js';
import { readRegularFile } from './read-regular.js';

/** Where the installer reports: a CLI passes its stdout/stderr and exit code; the app passes its log. */
export interface InstallIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** A step failed; the caller decides what that means (the CLI sets a non-zero exit code). */
  failed(): void;
}

export interface Pair {
  source: string;
  target: string;
}

const isSymlink = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;

export function copyFiles(pairs: Pair[], force: boolean, io: InstallIO): boolean {
  try {
    const link = force ? undefined : pairs.find(({ target }) => isSymlink(target));
    if (link) {
      io.stderr(`codechart: ${link.target}: is a symlink (use --force to replace it)\n`);
      io.failed();
      return false;
    }
    const conflict = force ? undefined : pairs.find(({ target }) => existsSync(target));
    if (conflict) {
      io.stderr(`exists: ${conflict.target} (use --force)\n`);
      io.failed();
      return false;
    }
    for (const { source, target } of pairs) {
      mkdirSync(dirname(target), { recursive: true });
      if (force && isSymlink(target)) unlinkSync(target);
      copyFileSync(source, target, force ? 0 : constants.COPYFILE_EXCL);
      io.stdout(`wrote ${target}\n`);
    }
    return true;
  } catch (e) {
    io.stderr(`codechart: ${(e as Error).message}\n`);
    io.failed();
    return false;
  }
}

// Errors such as ENOTDIR count as "not installed" so copyFiles reports them.
export const hasAny = (paths: string[]) =>
  paths.some((p) => {
    try {
      return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  });

export const sameFile = ({ source, target }: Pair) => {
  try {
    return readRegularFile(target, (st) => st.isFile()) === readFileSync(source, 'utf8');
  } catch {
    return false;
  }
};

// An older copy of ours is updated; anything else there needs --force. True when the targets end up holding this version.
export function installPairs(pairs: Pair[], where: string, who: string, ours: () => boolean, force: boolean, io: InstallIO): boolean {
  let update = force;
  if (!force && hasAny(pairs.map((p) => p.target))) {
    if (pairs.every(sameFile)) {
      io.stdout(`up to date for ${who}: ${where}\n`);
      return true;
    }
    let mine: boolean;
    try {
      mine = ours();
    } catch (e) {
      io.stderr(`codechart: ${(e as Error).message}\n`);
      io.failed();
      return false;
    }
    if (!mine) {
      io.stdout(`already installed for ${who}: ${where} (--force to update)\n`);
      return false;
    }
    update = true;
  }
  if (!copyFiles(pairs, update, { ...io, stdout: () => {} })) return false;
  io.stdout(`${update && !force ? 'updated' : 'installed'} for ${who}: ${where}\n`);
  return true;
}

/** The skill's files, SKILL.md first; it links to the other files. */
export const skillFiles = (dir: string): string[] => readdirSync(dir).sort((a, b) => Number(b === 'SKILL.md') - Number(a === 'SKILL.md'));

/** Copies `files` from `skillDir` into `dir`, updating an older codechart copy and leaving anything else for --force. */
export function installCopy(skillDir: string, dir: string, who: string, files: string[], force: boolean, io: InstallIO): boolean {
  const pairs = files.map((f) => ({ source: join(skillDir, f), target: join(dir, f) }));
  return installPairs(pairs, dir, who, () => isCodechartSkill(dir), force, io);
}

/** Deletes only the skill's own files, and the folder if that empties it. */
export function removeSkill(dir: string, files: string[]): string | undefined {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isDirectory()) return `left ${dir}: not a folder`;
  if (!isCodechartSkill(dir)) return `left ${dir}: not the codechart skill`;
  for (const f of files) if (lstatSync(join(dir, f), { throwIfNoEntry: false })?.isFile()) unlinkSync(join(dir, f));
  if (readdirSync(dir).length > 0) return `removed skill files from ${dir} (kept your other files there)`;
  rmdirSync(dir);
  return `removed skill: ${dir}`;
}
