#!/bin/sh
# Start development services and wait for this container boot's ready hooks.
set -eu
docker compose up -d floci dynamodb-admin
container="$(docker compose ps -q floci)"
started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container")"
attempt=0
while [ "$attempt" -lt 150 ]; do
  # Persisted env files alone may belong to an earlier container boot.
  if docker compose logs --no-color --since "$started_at" floci 2>/dev/null |
    grep -Fq 'mukuroji local S3 and SQS ready: services.env'; then
    if docker compose exec -T floci sh -c 'test -s /app/generated/cognito.env && test -s /app/generated/services.env'; then
      echo 'Local development services are ready.'
      exit 0
    fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo 'Floci initialization did not finish within 300 seconds. Inspect docker compose logs floci.' >&2
exit 1
