import { writeFileSync } from 'node:fs';
import { configJsonSchema } from '@codechart/core';

writeFileSync('packages/cli/config.schema.json', JSON.stringify(configJsonSchema(), null, 2) + '\n');
