"""Create or upgrade the local DynamoDB tables from tables.json.

tables.json is generated from the CDK data stores (bun run floci:tables), so this script holds no
schema of its own. It is safe to rerun: missing tables are created, missing indexes and TTL are
added in place, and a stored table whose keys differ from the definition stops initialization
with a recreate instruction instead of being changed.
"""

import json
import os
import subprocess
import sys
import time

ENDPOINT_URL = os.environ.get("AWS_ENDPOINT_URL") or "http://localhost:4566"
WAIT_SECONDS = 60
RECREATE_HINT = 'recreate the local data with "docker compose down --volumes" and run bun run floci:up'


class SchemaMismatch(Exception):
    """A stored local table cannot be upgraded to the generated definition in place."""


def aws(*args):
    """Run one AWS CLI DynamoDB call against Floci and return its parsed JSON output."""
    completed = subprocess.run(
        ["aws", "--endpoint-url", ENDPOINT_URL, "--output", "json", "dynamodb", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"aws dynamodb {args[0]} failed: {completed.stderr.strip()}")
    return json.loads(completed.stdout) if completed.stdout.strip() else {}


def describe_table(table_name):
    """Return the table description, or None when the table does not exist."""
    completed = subprocess.run(
        ["aws", "--endpoint-url", ENDPOINT_URL, "--output", "json", "dynamodb", "describe-table",
         "--table-name", table_name],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        if "ResourceNotFoundException" in completed.stderr:
            return None
        raise RuntimeError(f"aws dynamodb describe-table failed: {completed.stderr.strip()}")
    return json.loads(completed.stdout)["Table"]


def key_signature(key_schema, attribute_types):
    """Describe a key schema as comparable (name, key type, attribute type) tuples."""
    return sorted(
        (element["AttributeName"], element["KeyType"], attribute_types.get(element["AttributeName"]))
        for element in key_schema
    )


def projection_signature(projection):
    """Describe an index projection as a comparable tuple."""
    return (projection.get("ProjectionType"), tuple(sorted(projection.get("NonKeyAttributes", []))))


def index_attribute_definitions(table, index):
    """Return the attribute definitions an index's key schema needs."""
    types = {definition["AttributeName"]: definition for definition in table["attributeDefinitions"]}
    return [types[element["AttributeName"]] for element in index["KeySchema"]]


def wait_until_active(table_name):
    """Wait until the table and every global secondary index are ACTIVE."""
    for _ in range(WAIT_SECONDS):
        description = describe_table(table_name)
        if description is not None and description.get("TableStatus") == "ACTIVE" and all(
            index.get("IndexStatus", "ACTIVE") == "ACTIVE"
            for index in description.get("GlobalSecondaryIndexes", [])
        ):
            return description
        time.sleep(1)
    raise RuntimeError(f"DynamoDB table {table_name} or one of its indexes did not become ACTIVE.")


def create_table(table_name, table):
    """Create a table with every generated key, index, and billing setting."""
    request = {
        "TableName": table_name,
        "AttributeDefinitions": table["attributeDefinitions"],
        "KeySchema": table["keySchema"],
        "BillingMode": "PAY_PER_REQUEST",
    }
    if table["globalSecondaryIndexes"]:
        request["GlobalSecondaryIndexes"] = table["globalSecondaryIndexes"]
    aws("create-table", "--cli-input-json", json.dumps(request))


def reconcile_indexes(table_name, table, description):
    """Add generated indexes missing from a stored table and reject incompatible ones."""
    stored_types = {
        definition["AttributeName"]: definition["AttributeType"]
        for definition in description.get("AttributeDefinitions", [])
    }
    desired_types = {
        definition["AttributeName"]: definition["AttributeType"] for definition in table["attributeDefinitions"]
    }
    if key_signature(description["KeySchema"], stored_types) != key_signature(table["keySchema"], desired_types):
        raise SchemaMismatch(f"table {table_name} has a different primary key")
    stored_indexes = {index["IndexName"]: index for index in description.get("GlobalSecondaryIndexes", [])}
    for index in table["globalSecondaryIndexes"]:
        stored = stored_indexes.get(index["IndexName"])
        if stored is None:
            # DynamoDB accepts one index creation per UpdateTable call.
            aws("update-table", "--cli-input-json", json.dumps({
                "TableName": table_name,
                "AttributeDefinitions": index_attribute_definitions(table, index),
                "GlobalSecondaryIndexUpdates": [{"Create": index}],
            }))
            description = wait_until_active(table_name)
            stored_types = {
                definition["AttributeName"]: definition["AttributeType"]
                for definition in description.get("AttributeDefinitions", [])
            }
            continue
        if key_signature(stored["KeySchema"], stored_types) != key_signature(index["KeySchema"], desired_types) or (
            projection_signature(stored.get("Projection", {})) != projection_signature(index["Projection"])
        ):
            raise SchemaMismatch(f"index {index['IndexName']} of table {table_name} has a different key or projection")


def ensure_time_to_live(table_name, attribute_name):
    """Enable the generated TTL attribute, waiting out a pending disable."""
    for _ in range(WAIT_SECONDS):
        ttl = aws("describe-time-to-live", "--table-name", table_name).get("TimeToLiveDescription", {})
        status = ttl.get("TimeToLiveStatus")
        if status in ("ENABLED", "ENABLING"):
            if ttl.get("AttributeName") != attribute_name:
                raise SchemaMismatch(
                    f"table {table_name} expires items by {ttl.get('AttributeName')}, not {attribute_name}"
                )
            return
        if status != "DISABLING":
            aws("update-time-to-live", "--table-name", table_name, "--time-to-live-specification",
                json.dumps({"Enabled": True, "AttributeName": attribute_name}))
            return
        time.sleep(1)
    raise RuntimeError(f"TTL of DynamoDB table {table_name} is still disabling; retry local initialization later.")


def ensure_table(table):
    """Create or upgrade one generated table and return its local name."""
    table_name = os.environ.get(table["tableNameVariable"]) or table["tableName"]
    if describe_table(table_name) is None:
        create_table(table_name, table)
        wait_until_active(table_name)
    else:
        reconcile_indexes(table_name, table, wait_until_active(table_name))
    if table["timeToLiveAttribute"] is not None:
        ensure_time_to_live(table_name, table["timeToLiveAttribute"])
    return table_name


def main():
    """Ensure every table in the definitions file named by the first argument."""
    with open(sys.argv[1], encoding="utf-8") as definitions:
        tables = json.load(definitions)
    try:
        names = [ensure_table(table) for table in tables]
    except SchemaMismatch as error:
        print(f"Existing local DynamoDB schema does not match CDK: {error}; {RECREATE_HINT}.", file=sys.stderr)
        return 1
    print(f"mukuroji local DynamoDB tables ready: {len(names)} tables")
    return 0


if __name__ == "__main__":
    sys.exit(main())
