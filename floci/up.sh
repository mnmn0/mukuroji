#!/bin/sh
# Start development services and wait for this container boot's ready hooks.
# FLOCI_ENABLE_LAMBDA=1 also mounts the Docker socket so Floci can run Lambda containers.
set -eu
case "${FLOCI_ENABLE_LAMBDA:-0}" in
  0 | 1) ;;
  *)
    echo 'FLOCI_ENABLE_LAMBDA must be 0 or 1.' >&2
    exit 2
    ;;
esac
compose() {
  if [ "${FLOCI_ENABLE_LAMBDA:-0}" = 1 ]; then
    docker compose -f docker-compose.yml -f docker-compose.lambda.yml "$@"
  else
    docker compose "$@"
  fi
}
compose up -d floci dynamodb-admin
container="$(compose ps -q floci)"
started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container")"
attempt=0
while [ "$attempt" -lt 150 ]; do
  # Persisted env files alone may belong to an earlier container boot.
  if compose logs --no-color --since "$started_at" floci 2>/dev/null |
    grep -Fq 'mukuroji local S3 and SQS ready: services.env'; then
    if compose exec -T floci sh -c 'test -s /app/generated/cognito.env && test -s /app/generated/services.env'; then
      echo 'Local development services are ready.'
      exit 0
    fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo 'Floci initialization did not finish within 300 seconds. Inspect docker compose logs floci.' >&2
exit 1
