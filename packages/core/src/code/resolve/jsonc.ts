/** Index just past the string literal that starts at `i`. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Copies `text`, letting `skip` drop what follows index `i` outside strings: it returns the index to resume at, or undefined to keep the character. */
function scan(text: string, skip: (i: number) => number | undefined): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const next = skip(i);
    if (next === undefined) out += text[i++];
    else i = next;
  }
  return out;
}

function comment(text: string, i: number): number | undefined {
  if (text[i] !== '/') return undefined;
  if (text[i + 1] === '/') {
    const end = text.indexOf('\n', i);
    return end < 0 ? text.length : end;
  }
  if (text[i + 1] !== '*') return undefined;
  const end = text.indexOf('*/', i + 2);
  return end < 0 ? text.length : end + 2;
}

/** Parses JSON with comments and trailing commas, as tsconfig.json allows; undefined when it still isn't valid. */
export function parseJsonc(text: string): unknown {
  const src = text.replace(/^\uFEFF/, '');
  const bare = scan(src, (i) => comment(src, i));
  const closer = /\s*[}\]]/y;
  const trailing = (i: number) => {
    closer.lastIndex = i + 1;
    return bare[i] === ',' && closer.test(bare) ? i + 1 : undefined;
  };
  try {
    return JSON.parse(scan(bare, trailing));
  } catch {
    return undefined;
  }
}
