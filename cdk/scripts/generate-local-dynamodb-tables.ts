import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderLocalDynamoDbTables } from '../lib/local-dynamodb-tables';

/** Committed table definitions read by the Floci ready hook. */
const OUTPUT_PATH = resolve(__dirname, '../../floci/init/dynamodb/tables.json');

/**
 * Writes the Floci table definitions, or with `--check` fails when the committed file is stale.
 */
function main(): void {
  const rendered = renderLocalDynamoDbTables();
  if (process.argv.includes('--check')) {
    if (readFileSync(OUTPUT_PATH, 'utf8') !== rendered) {
      console.error('floci/init/dynamodb/tables.json is stale. Run: bun run floci:tables');
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUTPUT_PATH, rendered);
}

main();
