import { programs } from './generate.js';

/** Dumps every generated program and the shared `b.py` for `record.py`: `dump.ts | python3 -I record.py`. */
const all = programs();
process.stdout.write(JSON.stringify({ b: all[0]?.b, programs: all.map(({ id, text }) => ({ id, text })) }));
