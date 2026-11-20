import { writeFileSync } from 'node:fs';
import { configJsonSchema } from '../packages/cli/src/config/schema.js';

writeFileSync('packages/cli/config.schema.json', JSON.stringify(configJsonSchema(), null, 2) + '\n');
