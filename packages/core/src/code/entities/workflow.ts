import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { CodeRef } from '../model.js';
import { commandRefs } from './refs.js';
import type { Lines } from './text.js';
import { get, text, type YMap, type YValue } from './yaml.js';

/** GitHub runs only the files directly in the root `.github/workflows`. */
export const isWorkflow = (path: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

/** `docker-compose.yml`, `compose.yaml`, `docker-compose.prod.yml`, `compose.override.yml`… in any folder. */
export const isCompose = (path: string): boolean => /(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/.test(path);

/** An entity as found, before ids are given. */
export interface Found {
  path: string[];
  kind: 'job' | 'step' | 'service';
  node: Node;
}

/** What the folder a step runs from depends on: unknown (an expression decides it) or a repo folder, or outside the repo. */
type Folder = { fixed: true; dir: string | undefined } | { fixed: false };
const UNFIXED: Folder = { fixed: false };

const hasExpression = (value: string | undefined): boolean => value?.includes('${{') ?? false;

const runDefault = (scope: YValue | undefined, key: string): string | undefined => text(get(get(get(scope, 'defaults'), 'run'), key));

const labelsOf = (value: YValue | undefined): (string | undefined)[] => (value?.kind === 'seq' ? value.items.map((i) => text(i.value)) : [text(value)]);

/** How a job's runner decides its default shell: bash unless Windows (pwsh), unknown when an expression picks the runner. */
function runnerShell(job: YValue | undefined): 'bash' | 'pwsh' | 'unknown' {
  const runsOn = get(job, 'runs-on');
  const labels = runsOn?.kind === 'map' ? [text(get(runsOn, 'group')), ...labelsOf(get(runsOn, 'labels'))] : labelsOf(runsOn);
  if (labels.some((l) => l !== undefined && /windows/i.test(l))) return 'pwsh';
  return labels.some(hasExpression) ? 'unknown' : 'bash';
}

/** Whether a step's commands are read: `bash` or `sh` (any flags), unknown when the shell is an expression or the runner's. */
function readShell(shell: string | undefined, runner: 'bash' | 'pwsh' | 'unknown'): 'yes' | 'no' | 'unfixed' {
  if (shell === undefined) return runner === 'bash' ? 'yes' : runner === 'pwsh' ? 'no' : 'unfixed';
  if (hasExpression(shell)) return 'no';
  return /^(bash|sh)(\s|$)/.test(shell.trim()) ? 'yes' : 'no';
}

const segments = (dir: string): string[] | undefined => {
  if (dir.startsWith('/') || hasExpression(dir)) return undefined;
  const normal = posix.normalize(dir || '.');
  if (normal === '..' || normal.startsWith('../')) return undefined;
  return normal === '.' || normal === './' ? [] : normal.replace(/\/$/, '').split('/');
};

/**
 * The repo folder a step runs from: its working directory (relative to $GITHUB_WORKSPACE), seen from where the last
 * `actions/checkout` of this repo put it. Without such a checkout the repo's files are not there.
 */
function stepFolder(checkout: Folder, workingDirectory: string | undefined): Folder {
  if (!checkout.fixed || checkout.dir === undefined) return UNFIXED;
  const wd = segments(workingDirectory ?? '');
  const repo = segments(checkout.dir);
  if (!wd || !repo) return UNFIXED;
  if (repo.some((part, i) => wd[i] !== part)) return { fixed: true, dir: undefined };
  return { fixed: true, dir: wd.slice(repo.length).join('/') };
}

/** Where a checkout step puts this repo: the workspace or its `path`; unfixed for another repository or an expression. */
function checkoutOf(step: YValue | undefined, previous: Folder): Folder {
  const uses = text(get(step, 'uses'));
  if (!uses || !/^actions\/checkout(@|$)/.test(uses)) return previous;
  const options = get(step, 'with');
  // Another repository in the workspace: this one's files are not where the steps look.
  if (get(options, 'repository') !== undefined) return UNFIXED;
  const path = text(get(options, 'path'));
  if (path === undefined) return { fixed: true, dir: '' };
  return segments(path) ? { fixed: true, dir: path } : UNFIXED;
}

const stepName = (step: YValue | undefined, index: number): string =>
  [text(get(step, 'id')), text(get(step, 'name')), text(get(step, 'uses'))].find((n) => n?.trim()) ?? `#${index + 1}`;

/** One step's references: the files its `run` commands run, when its shell is bash or sh. */
function stepRefs(file: string, lines: Lines, step: YValue | undefined, folder: Folder, read: 'yes' | 'no' | 'unfixed', from: string | undefined): CodeRef[] {
  const run = get(step, 'run');
  if (run?.kind !== 'scalar' || read === 'no') return [];
  const base = read === 'yes' && folder.fixed ? folder.dir : undefined;
  return commandRefs(file, run.value, lines, base, from);
}

/**
 * Jobs and steps of a workflow, and the files `run` steps run. `refs` takes each entity's id once ids are numbered, so a
 * reference can name the step it sits in.
 */
export function workflowEntities(file: string, root: YValue | undefined, lines: Lines): { found: Found[]; refs: (idOf: (found: Found) => string | undefined) => CodeRef[] } {
  const found: Found[] = [];
  const pending: { step: Found; run: (from: string | undefined) => CodeRef[] }[] = [];
  const jobs = get(root, 'jobs');
  for (const pair of jobs?.kind === 'map' ? jobs.pairs : []) {
    found.push({ path: [pair.key], kind: 'job', node: pair.node });
    const job = pair.value;
    const runner = runnerShell(job);
    const steps = get(job, 'steps');
    let checkout: Folder = { fixed: true, dir: undefined };
    for (const [index, item] of (steps?.kind === 'seq' ? steps.items : []).entries()) {
      const step: Found = { path: [pair.key, stepName(item.value, index)], kind: 'step', node: item.node };
      found.push(step);
      const shell = text(get(item.value, 'shell')) ?? runDefault(job, 'shell') ?? runDefault(root, 'shell');
      const workingDirectory = text(get(item.value, 'working-directory')) ?? runDefault(job, 'working-directory') ?? runDefault(root, 'working-directory');
      const folder = stepFolder(checkout, workingDirectory);
      const read = readShell(shell, runner);
      pending.push({ step, run: (from) => stepRefs(file, lines, item.value, folder, read, from) });
      checkout = checkoutOf(item.value, checkout);
    }
  }
  return { found, refs: (idOf) => pending.flatMap((p) => p.run(idOf(p.step))) };
}

/** The services of a compose file. */
export function composeEntities(root: YValue | undefined): Found[] {
  const services = get(root, 'services');
  return (services?.kind === 'map' ? (services as YMap).pairs : []).map((p) => ({ path: [p.key], kind: 'service', node: p.node }));
}
