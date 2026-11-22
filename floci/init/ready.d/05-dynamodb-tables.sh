#!/bin/sh
# Local DynamoDB tables generated from the CDK data stores. Safe to rerun without deleting data.
# Edit cdk/lib/subsystems/data-stores.ts and run bun run floci:tables; do not define schemas here.
set -eu
export AWS_DEFAULT_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
python3 /etc/floci/init/dynamodb/ensure_tables.py /etc/floci/init/dynamodb/tables.json
