import { add, upper, formatDate, clock, twice, missing } from '@mono/lib';
import { slug } from '@mono/lib/utils/slug';
import secret from '@mono/lib/internal/secret';
import { helper } from '@app/util/helper.js';
import { nothing } from '@app/nothing';
import { readFile } from 'node:fs';
import path from 'path';
import { z } from 'zod';
import { gone } from './gone.js';
import config from '#config';
import * as views from './views';
import type { Mode } from './esm.mjs';

export async function load(name: string) {
  const lazy = await import('./lazy.js');
  const picked = await import(`./views/${name}.js`);
  return [lazy, picked, add, upper, formatDate, clock, twice, missing, slug, secret, helper, nothing, readFile, path, z, gone, config, views] as const;
}
export type { Mode };
