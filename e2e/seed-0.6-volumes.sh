#!/bin/bash
#
# `make e2e` runs this as root in the runner image before the stack starts: the volumes then look as
# an Emberline 0.6.x runner left them, links an agent could have planted included. smoke.mjs checks
# that the 0.7.0 runner re-owns only what ptyd and the browser daemon need, follows none of the links,
# and leaves the agents' files (runner-home, runner-tools, /workspaces) as they were.
set -e

# The agents' files: node's in every release.
for dir in /home/node /opt/ai-tools /workspaces; do
  install -o node -g node -m 0644 /dev/null "$dir/.e2e-0.6-marker"
done

# The ptyd-socket volume as 0.6.0 left it: node's, with ptyd's socket and the browser daemon's files
# side by side, and links where 0.7.0's directories go.
rm -rf /run/emberline/ptyd /run/emberline/browser /run/emberline/agent-events
chown node:node /run/emberline
for file in ptyd.sock browser-daemon.mjs playwright-hook.cjs browser-tabs.json; do
  install -o node -g node -m 0644 /dev/null "/run/emberline/$file"
done
ln -s /home/node /run/emberline/ptyd
ln -s /workspaces /run/emberline/browser
ln -s /opt/ai-tools /run/emberline/agent-events
chown -h node:node /run/emberline/ptyd /run/emberline/browser /run/emberline/agent-events

# The runner-logs volume: node's session logs, and a link to the agents' home.
chown node:node /var/log/emberline
install -o node -g node -m 0600 /dev/null /var/log/emberline/0.6-session.log
ln -s /home/node/.e2e-0.6-marker /var/log/emberline/planted
chown -h node:node /var/log/emberline/planted
