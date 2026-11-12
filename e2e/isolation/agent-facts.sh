#!/bin/bash
#
# Run by e2e/isolation/run.mjs in an agent terminal (the runner's ptyd, as node), while another
# terminal is open and an import clone in the ops container is held at the fake forge. Reports what
# an agent sees as E2E:key=value lines; run.mjs asserts on them. Nothing here may fail the script:
# every probe reports its outcome instead.
r() { printf 'E2E:%s=%s\n' "$1" "$2"; }
here="$(dirname "$0")"

# SR-01: who the agent is.
r user "$(id -un)"
r groups "$(id -Gn)"
r joinCoreGroup "$(sg emberline-core -c 'id -gn' </dev/null 2>/dev/null || echo refused)"
r ownCaps "$(awk '/^Cap(Inh|Prm|Eff|Amb)/{printf "%s=%s ", $1, $2}' /proc/$$/status)"

# SR-02 / SR-04: ptyd as the agent sees it.
ptyd_pids="$(ps -u ptyd -o pid= | tr -s ' \n' ' ')"
r ptydCount "$(echo $ptyd_pids | wc -w)"
r ptydCaps "$(for p in $ptyd_pids; do awk '/^CapEff/{e=$2} /^CapBnd/{b=$2} END{print "eff=" e " bnd=" b}' /proc/$p/status; done | sort -u | tr '\n' ' ')"
r ptydKill "$(for p in $ptyd_pids; do kill -0 "$p" 2>/dev/null && echo allowed || echo refused; done | sort -u | tr '\n' ' ')"
r ptydEnviron "$(for p in $ptyd_pids; do cat "/proc/$p/environ" >/dev/null 2>&1 && echo readable || echo refused; done | sort -u | tr '\n' ' ')"

# SR-03: ptyd's socket.
r ptydSocket "$(node -e "require('net').connect('/run/emberline/ptyd/ptyd.sock').on('connect', () => console.log('connected')).on('error', (e) => console.log(e.code))" 2>&1)"
r ptydDir "$(stat -c '%U:%G %a' /run/emberline/ptyd)"

# SR-05: this session's descriptors: its own terminal on 0-2, never another session's (a pty master,
# /dev/ptmx, or another /dev/pts device).
own="$(readlink /proc/$$/fd/0)"
foreign=''
for fd in /proc/$$/fd/*; do
  t="$(readlink "$fd")" || continue
  case "$t" in *ptmx | /dev/pts/*) [ "$t" = "$own" ] || foreign="$foreign ${fd##*/}:$t" ;; esac
done
r ownTerminal "$own"
r stdioTerminals "$(for n in 0 1 2; do readlink /proc/$$/fd/$n; done | sort -u | wc -l)"
r foreignTerminals "${foreign:-none}"

# SR-07: the ops service's socket volume.
r opsDir "$([ -e /run/emberline-ops ] && echo present || echo absent)"

# SR-08: every process the agent can see: whose it is, and whether a command line or environment
# holds one of core's secrets or a one-time address of the git gateway (patterns from a file, so they
# are in no command line here).
r users "$(ps -eo user= | sort -u | tr '\n' ' ')"
leaks=''
readable=0
for p in /proc/[0-9]*; do
  [ "${p#/proc/}" = "$$" ] && continue
  for f in cmdline environ; do
    content="$(tr '\0' '\n' <"$p/$f" 2>/dev/null)" || continue
    [ "$f" = environ ] && [ -n "$content" ] && readable=$((readable + 1))
    if printf '%s\n' "$content" | grep -qEf "$here/secret-patterns.txt"; then leaks="$leaks ${p#/proc/}/$f"; fi
  done
done
r environsRead "$readable"
r secretLeaks "${leaks:-none}"

# SR-09: private SSH keys anywhere the runner mounts or the agent can write. The Docker engine's TLS
# client key (/run/emberline-docker-certs) is the agents' by design and is not an SSH key.
keys="$(grep -rlsIE -e '-----BEGIN (OPENSSH|RSA|DSA|EC|ENCRYPTED) PRIVATE KEY-----' \
  /workspaces /home/node /opt/ai-tools /run/emberline /var/log/emberline /tmp 2>/dev/null | tr '\n' ' ')"
r sshKeys "${keys:-none}"
r logDirReadable "$([ -r /var/log/emberline ] && echo readable || echo refused)"

# SR-10: the browser daemon.
w=''
for f in /opt/emberline/browser/browser-daemon.mjs /opt/emberline/browser/playwright-hook.cjs /opt/emberline/browser/planted; do
  if (: >>"$f") 2>/dev/null; then w="$w writable"; else w="$w refused"; fi
done
r browserFiles "$w"
r browserScriptDir "$(stat -c '%U:%G %a' /opt/emberline/browser)"
browser_pids="$(ps -u browser -o pid= | tr -s ' \n' ' ')"
r browserRunning "$([ -n "$browser_pids" ] && echo yes || echo no)"
r browserCaps "$(for p in $browser_pids; do awk '/^CapEff/{print $2}' /proc/$p/status 2>/dev/null; done | sort -u | tr '\n' ' ')"
r browserKill "$(for p in $browser_pids; do kill -0 "$p" 2>/dev/null && echo allowed || echo refused; done | sort -u | tr '\n' ' ')"

# SR-11: the service directories as the entrypoint made them over the 0.6.x volumes (e2e/seed-0.6-volumes.sh).
r runDir "$(stat -c '%U:%G %a' /run/emberline)"
r browserDir "$(stat -c '%U:%G %a' /run/emberline/browser)"
r eventsDir "$(stat -c '%U:%G %a' /run/emberline/agent-events)"
r oldSocket "$([ -e /run/emberline/ptyd.sock ] && echo present || echo absent)"
r logDir "$(stat -c '%U:%G %a' /var/log/emberline)"
r agentFiles "$(stat -c '%U:%G' /home/node /opt/ai-tools /home/node/.e2e-0.6-marker /opt/ai-tools/.e2e-0.6-marker /workspaces/.e2e-0.6-marker 2>&1 | tr '\n' ' ')"
