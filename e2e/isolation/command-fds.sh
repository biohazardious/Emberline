#!/bin/bash
#
# The build script of run.mjs's project (SR-06): a command core runs in the runner (no terminal of
# its own) reports every terminal descriptor held by it and by its ancestors up to ptyd, whose
# descriptors node cannot read. With another terminal open, a command that inherited ptyd's
# descriptors holds that session's pty master.
p=$$
found=''
while [ "$p" -gt 1 ] && [ -r "/proc/$p/fd" ]; do
  for fd in /proc/"$p"/fd/*; do
    t="$(readlink "$fd")" || continue
    case "$t" in *ptmx | /dev/pts/*) found="$found $p:${fd##*/}:$t" ;; esac
  done
  p="$(awk '/^PPid:/{print $2}' "/proc/$p/status")"
done
echo "command-terminals=${found:-none}"
mkdir -p dist
echo '<h1>isolation</h1>' >dist/index.html
