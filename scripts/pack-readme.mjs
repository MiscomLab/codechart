import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = 'https://raw.githubusercontent.com/MiscomLab/codechart/main/';
const BLOB = 'https://github.com/MiscomLab/codechart/blob/main/';
const root = join(import.meta.dirname, '..');

const isRelative = (u) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u);
const abs = (base, u) => base + u.replace(/^\.\//, '');

const text = readFileSync(join(root, 'README.md'), 'utf8')
  .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (m, bang, label, url, title) => (isRelative(url) ? `${bang}[${label}](${abs(bang ? RAW : BLOB, url)}${title})` : m))
  .replace(/\b(src|href)="([^"]+)"/g, (m, attr, url) => (isRelative(url) ? `${attr}="${abs(attr === 'src' ? RAW : BLOB, url)}"` : m));

writeFileSync(join(root, 'packages', 'cli', 'README.md'), text);
