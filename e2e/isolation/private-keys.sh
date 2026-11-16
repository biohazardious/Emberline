#!/bin/sh
#
# Prints each file under the given paths that holds a PEM private key (OpenSSH, PKCS#1 RSA/DSA/EC,
# PKCS#8 plain or encrypted, SSH2, PGP): the header, then the key itself, in a file or escaped in a
# string (JSON's \n). A header with no key after it is not one: litellm's provider form (installed
# with Aider) shows "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----" as a
# placeholder. A file the second read fails on is printed too. Exits 1 when it printed any file.
# Used by SR-09 (e2e/isolation/agent-facts.sh) and SR-19 (e2e/isolation.sh).
#
# Usage: private-keys.sh <path>...
set -u
header='-{4,5} ?BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)? ?-{4,5}'
# A line break, real or escaped.
nl='(\r?\n|(\\r)?\\n)'
# RFC 1421 / RFC 4716 / OpenPGP armor headers (Proc-Type, DEK-Info, Comment, Version), a value
# continued with a trailing backslash, then the blank line some formats put before the body.
fields="([A-Za-z-]+:[^\\r\\n\\\\]*(\\\\\\r?\\n[^\\r\\n\\\\]*)*$nl)*$nl?"
key="$header$nl$fields[A-Za-z0-9+/=]{40}"
found="$(grep -rlsIE -e "$header" "$@" | while IFS= read -r f; do
  grep -qsazP -e "$key" "$f"
  [ "$?" -eq 1 ] || printf '%s\n' "$f"
done)"
[ -z "$found" ] || {
  printf '%s\n' "$found"
  exit 1
}
