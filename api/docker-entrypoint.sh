#!/bin/sh
# Generate the session secret once and keep it in the data volume, so no .env is needed.
if [ -z "$SESSION_SECRET" ]; then
  [ -s /data/session_secret ] || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' > /data/session_secret
  export SESSION_SECRET="$(cat /data/session_secret)"
fi
exec "$@"
