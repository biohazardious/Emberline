#!/bin/bash
#
# `make e2e-upgrade`: the upgrade paths from 0.5, 0.6 and 0.7 data volumes to the current images.
# For each release it seeds the data volume as that release left it (its migrations, a project, a
# ticket, a run, a review comment and a secret), starts the current core under that release's own
# compose file, and checks (e2e/upgrade-check.mjs):
#   - a pre-migration snapshot exists, as the old release left the database
#   - every migration is applied, the seeded rows survive, and the secret opens with the same key
#   - the ops-missing banner shows for a compose file without `ops` and clears with the current one
#   - the rollback drill: the snapshot back in place opens under the previous release's migrations
# `upgrade-check.mjs matrix` then upgrades from every migration step of this release.
# Needs the images emberline/core:<tag> and emberline/runner:<tag> (make e2e builds them; the tag is
# $EMBERLINE_E2E_TAG, `e2e` by default, which `make E2E_TAG=...` sets) and the release tags.
# Every exit, failed or not, removes the stacks, volumes and temp dirs it made.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSIONS=${UPGRADE_VERSIONS:-"0.5.2 0.6.2 0.7.0"}
# The compose files read the same variable for their images.
export EMBERLINE_E2E_TAG=${EMBERLINE_E2E_TAG:-e2e}
CORE=emberline/core:$EMBERLINE_E2E_TAG
RUNNER=emberline/runner:$EMBERLINE_E2E_TAG
# Another tag is another (parallel) run: its stacks get their own project names.
if [ "$EMBERLINE_E2E_TAG" = e2e ]; then
  BASE=${EMBERLINE_COMPOSE_PROJECT:-emberline-upgrade}
else
  BASE=${EMBERLINE_COMPOSE_PROJECT:-emberline-upgrade-$(printf '%s' "$EMBERLINE_E2E_TAG" | tr -c 'a-z0-9_-' '-')}
fi
WORK=$(mktemp -d)
WS=$(mktemp -d)
chmod 777 "$WS"
export EMBERLINE_WORKSPACES_HOST_DIR=$WS
project=""

# Takes down a release's stack under both compose files (each declares volumes the other may not),
# then removes every volume left with the project's prefix: the seed volume and those `docker run -v`
# created for a compose file that does not declare them.
teardown() { # teardown <project>
  [ -f "$WORK/old.yaml" ] && docker compose -p "$1" --project-directory "$PWD" -f "$WORK/old.yaml" -f e2e/compose.upgrade-old.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  docker compose -p "$1" -f compose.yaml -f e2e/compose.e2e.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=${1}_" | grep "^${1}_" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
}
cleanup() {
  [ -z "$project" ] || teardown "$project"
  rm -rf "$WORK" "$WS" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[ -n "$(docker images -q "$CORE")" ] || { echo "image $CORE is missing: run make e2e or build the core and runner targets as :$EMBERLINE_E2E_TAG" >&2; exit 1; }

# The engine may be remote, so the helper travels on stdin, not in a bind mount.
run_check() { # run_check <docker run options...> -- <mode> [args]
  local opts=()
  while [ "$1" != "--" ]; do opts+=("$1"); shift; done; shift
  docker run --rm -i -w /app "${opts[@]}" "$CORE" node --input-type=module - "$@" < e2e/upgrade-check.mjs
}
api_check() { # api_check <project> <ops-missing|ops-ok>
  run_check --network "${1}_default" -- api http://core:7420 "$2"
}

for version in $VERSIONS; do
  echo "=== upgrade from $version ==="
  project="${BASE}-${version//./-}"
  tag="v$version"
  git show "$tag:compose.yaml" > "$WORK/old.yaml"
  mkdir -p "$WORK/$version"
  git archive "$tag" apps/core/drizzle | tar -x -C "$WORK/$version"
  # The engine may be remote: the old migrations travel in a volume, not a bind mount.
  OLD="docker compose -p $project --project-directory $PWD -f $WORK/old.yaml -f e2e/compose.upgrade-old.yaml"
  NEW="docker compose -p $project -f compose.yaml -f e2e/compose.e2e.yaml"
  has_ops=0; grep -q '^  ops:' "$WORK/old.yaml" && has_ops=1

  $OLD create >/dev/null
  drizzle_vol="${project}_seed-drizzle"
  docker volume create "$drizzle_vol" >/dev/null
  tar -C "$WORK/$version/apps/core" -c drizzle | docker run --rm -i -v "$drizzle_vol:/old" "$RUNNER" tar -x -C /old --strip-components=1
  seed_run() { run_check --user root -v "$drizzle_vol:/old:ro" -v "${project}_data:/data" -e EMBERLINE_DATA_DIR=/data -- "$@"; }
  verify_run() { run_check --user root -v "${project}_data:/data" -e EMBERLINE_DATA_DIR=/data -- "$@"; }
  chown_data() { docker run --rm --user root -v "${project}_data:/data" "$CORE" chown -R node:node /data; }

  # The runner volumes as 0.6.x left them (older releases left the same files).
  docker run --rm -i --user root -v "$WS:/workspaces" \
    -v "${project}_ptyd-socket:/run/emberline" -v "${project}_runner-logs:/var/log/emberline" \
    -v "${project}_runner-home:/home/node" -v "${project}_runner-tools:/opt/ai-tools" \
    "$RUNNER" bash -s < e2e/seed-0.6-volumes.sh
  seed_run seed /old "$version"
  chown_data

  echo "--- the current core under the $version compose file"
  $OLD up -d --wait core
  api_check "$project" "$([ $has_ops = 1 ] && echo ops-ok || echo ops-missing)"
  $OLD stop core >/dev/null
  verify_run verify "$version"

  echo "--- the current compose file"
  $NEW up -d --wait core runner ops
  api_check "$project" ops-ok
  $NEW stop core >/dev/null

  echo "--- rollback drill: restore the snapshot"
  seed_run restore /old "$version"
  chown_data
  $NEW up -d --wait core
  api_check "$project" ops-ok
  $NEW stop core >/dev/null
  verify_run verify "$version"

  teardown "$project"
  project=""
done

echo "=== every migration step of this release ==="
run_check -- matrix
echo "upgrade paths ok: $VERSIONS"
