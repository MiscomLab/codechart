import { programs } from './generate.js';

/** Dumps every generated program for `record.py`: `dump.ts | python3 -I record.py`. */
process.stdout.write(JSON.stringify({ programs: programs().map(({ id, text }) => ({ id, text })) }));
