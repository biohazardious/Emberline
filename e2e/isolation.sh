#!/bin/sh
#
# Isolation regression suite (make e2e): SECURITY.md's "The shared runner" guarantees as named
# checks (SR-nn, listed in docs/TESTING.md) against the running e2e stack. e2e/isolation/run.mjs
# checks what an agent terminal sees (SR-01 to SR-13); this script then runs what needs another
# container: the signed-in cookie replayed from ops and from a container named `docker`, the git
# gateway from ops and from a stranger, every volume runner and ops mount scanned for a private SSH
# key as root, and which service mounts which volume.
#
# Usage: e2e/isolation.sh <compose project> [image tag]. Needs the e2e stack up (see `make e2e`) and
# the environment `make e2e` exports (EMBERLINE_WORKSPACES_HOST_DIR).
set -u
project="$1"
tag="${2:-e2e}"
compose="docker compose -p $project -f compose.yaml -f e2e/compose.e2e.yaml"
network="${project}_default"
core_image="emberline/core:$tag"
runner_image="emberline/runner:$tag"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
failed=0

pass() { echo "ok   $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}
# check <name> <command…>: the command's output is the failure's detail.
check() {
  name="$1"
  shift
  if detail="$("$@" 2>&1)"; then pass "$name"; else fail "$name" "$detail"; fi
}

# A probe (e2e/isolation/probe.mjs) from a new container on the e2e network named `docker`, the
# Docker engine's name (no engine runs in e2e).
probe_as_docker() {
  docker run --rm --network "$network" --network-alias docker -e E2E_COOKIE -e E2E_PROBE_WAIT_MS \
    -v "$PWD/e2e:/e2e:ro" "$core_image" node /e2e/isolation/probe.mjs http://core:7420 "$@"
}

# The same probe in a running service (piped in: ops mounts no e2e/). The fake forge stands for any
# other container on the network: its address is stable, and never the one the suite signed in from.
probe_in() {
  service="$1"
  shift
  $compose exec -T -e E2E_COOKIE -e E2E_PROBE_WAIT_MS "$service" node - http://core:7420 "$@" <e2e/isolation/probe.mjs
}

docker run --rm --user node --network "$network" -v "$PWD/e2e:/e2e:ro" "$runner_image" \
  node /e2e/isolation/run.mjs http://core:7420 --print-session >"$out/agent.log" 2>&1 || failed=1
grep -v '^E2E_SESSION_COOKIE=' "$out/agent.log"
E2E_COOKIE="$(sed -n 's/^E2E_SESSION_COOKIE=//p' "$out/agent.log")"
[ -n "$E2E_COOKIE" ] || {
  echo "FAIL the agent-side suite ended before it handed over its session for the replays"
  exit 1
}
E2E_PROBE_WAIT_MS=0
export E2E_COOKIE E2E_PROBE_WAIT_MS

check 'SR-14 a session cookie replayed from the ops container is refused' \
  probe_in ops cookie '403 session_from_container'
check 'SR-17 the git gateway accepts the ops container (an unknown operation: 404, not 403)' \
  probe_in ops gateway '404'
check 'SR-18 the git gateway refuses any other container on the network' \
  probe_in forge gateway '403'
# A stranger gets 401, not 403: SR-12, SR-14 and SR-15 refuse by name, not by address change.
check 'SR-16 a session cookie replayed from another address is signed out (control)' \
  probe_in forge cookie '401 session_address_changed'
# Core resolves `docker` once a minute: the container answering to that name is refused within 70 s.
E2E_PROBE_WAIT_MS=75000
check 'SR-15 a session cookie replayed from a container named docker is refused' \
  probe_as_docker cookie '403 session_from_container'

# SR-19: every volume the runner or ops mounts, read as root. The Docker engine's TLS client key
# (docker-client-certs) is the agents' by design and is not an SSH key.
scan_volumes() {
  docker run --rm --user root --entrypoint /bin/sh \
    -v "${project}_ptyd-socket:/scan/ptyd-socket:ro" -v "${project}_ops-socket:/scan/ops-socket:ro" \
    -v "${project}_runner-home:/scan/runner-home:ro" -v "${project}_runner-tools:/scan/runner-tools:ro" \
    -v "${project}_runner-logs:/scan/runner-logs:ro" -v "$EMBERLINE_WORKSPACES_HOST_DIR:/scan/workspaces:ro" \
    "$runner_image" -c "! grep -rlsIE -e '-----BEGIN (OPENSSH|RSA|DSA|EC|ENCRYPTED) PRIVATE KEY-----' /scan"
}
check 'SR-19 no private SSH key in any volume the runner or ops mounts' scan_volumes

# SR-20: who mounts what (SECURITY.md: ops-socket only in core and ops; ops without the runner's
# home, AI tools, logs or ptyd's socket).
mounts() {
  for id in $(docker ps -q --filter "label=com.docker.compose.project=$project"); do
    docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}{{range .Mounts}} {{.Name}}:{{.Destination}}{{end}}' "$id"
  done
}
check_mounts() {
  table="$(mounts)"
  bad="$(echo "$table" | awk -v p="${project}_" '
    { svc = $1
      for (i = 2; i <= NF; i++) {
        split($i, m, ":"); vol = m[1]; sub(p, "", vol); dest = m[2]
        if (vol == "ops-socket" && svc != "core" && svc != "ops") print svc " mounts ops-socket"
        if (vol == "ptyd-socket" && svc != "core" && svc != "runner") print svc " mounts ptyd-socket"
        if (svc == "ops" && (dest == "/home/node" || dest == "/opt/ai-tools" || dest == "/var/log/emberline" || dest == "/run/emberline"))
          print "ops mounts " dest
      } }')"
  echo "$table" | grep -q '^ops ' || bad="no ops container"
  [ -z "$bad" ] || {
    echo "$bad"
    return 1
  }
}
check "SR-20 only core and ops mount ops' socket, and ops mounts none of the runner's home, tools, logs or socket" check_mounts

[ "$failed" -eq 0 ] && echo "isolation suite passed" || echo "isolation suite FAILED"
exit "$failed"
