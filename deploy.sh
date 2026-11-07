#!/usr/bin/env bash
# One-command deploy to any Linux box with Docker, over SSH.
#
#   ./deploy.sh 192.168.1.50              # push code, build, (re)start
#   ./deploy.sh 192.168.1.50 --migrate    # first move: also bring this machine's data across
#   ./deploy.sh user@host --port 9090      # different user / published port
#   ./deploy.sh 192.168.1.50 --tunnel     # also run a Cloudflare Tunnel (asks for its token, stored only on the server)
#
# Safe to re-run: code is synced, the remote .env is created once and never overwritten,
# and data volumes are only touched with --migrate (which refuses if the target already has data).
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[[ $# -ge 1 ]] || usage
TARGET=$1; shift
MIGRATE=0 PORT=8080 DIR=marquee TUNNEL=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --migrate) MIGRATE=1 ;;
    --tunnel) TUNNEL=1 ;;
    --port) PORT=$2; shift ;;
    --dir) DIR=$2; shift ;;
    *) usage ;;
  esac
  shift
done

HERE=$(cd "$(dirname "$0")" && pwd)
HOST=${TARGET#*@}
PROJECT=marquee
VOLUMES=(appdata pgdata redisdata meilidata)
say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
remote() { ssh -o ConnectTimeout=8 "$TARGET" "$@"; }

say "Checking $TARGET"
remote true || { echo "Can't SSH to $TARGET. Set up a key first: ssh-copy-id $TARGET"; exit 1; }
remote 'command -v docker >/dev/null && docker compose version >/dev/null 2>&1' \
  || { echo "Docker with the compose plugin isn't installed on $HOST."; exit 1; }
# Plain `docker` (docker group), not sudo: sudo would need a TTY, which corrupts the data piped in --migrate.
remote 'docker info >/dev/null 2>&1' || {
  echo "Your user on $HOST can't run docker without sudo. Fix it once with:"
  echo "  ssh -t $TARGET 'sudo usermod -aG docker \$USER'"
  echo "then run this script again."
  exit 1
}
rdocker() { remote "cd ~/$DIR && docker $*"; }

say "Syncing code to $HOST:~/$DIR"
rsync -az --delete \
  --exclude .env --exclude /backups --exclude .git --exclude node_modules --exclude dist --exclude .venv \
  --exclude __pycache__ --exclude .pytest_cache --exclude '*.db' --exclude .DS_Store --exclude '*.zip' \
  "$HERE/" "$TARGET:$DIR/"

say "Writing .env (first deploy only)"
remote "cd ~/$DIR && [ -f .env ] || cat > .env" <<EOF
# Created by deploy.sh. Edit freely; deploy.sh never overwrites this file.
HTTP_PORT=$PORT
PUBLIC_WATCH_URL=http://$HOST:$PORT
POSTGRES_PASSWORD=$(openssl rand -hex 16)
MEILI_MASTER_KEY=$(openssl rand -hex 16)
EOF

if [[ $TUNNEL == 1 ]]; then
  # The token is read without echo and sent over SSH stdin: never on a command line, in history or in this repo.
  read -rsp "Cloudflare Tunnel token (the long eyJ... string; input hidden): " TOKEN; echo
  [[ $TOKEN == eyJ* ]] || { echo "That doesn't look like a tunnel token (they start with eyJ)."; exit 1; }
  printf '%s' "$TOKEN" | remote "cd ~/$DIR && umask 077 && sed -i -e '/^CLOUDFLARE_TUNNEL_TOKEN=/d' -e '/^COMPOSE_PROFILES=/d' .env \
    && { printf 'CLOUDFLARE_TUNNEL_TOKEN='; cat; printf '\nCOMPOSE_PROFILES=tunnel\n'; } >> .env && chmod 600 .env"
  unset TOKEN
  say "Tunnel token saved on $HOST. In Cloudflare, route your hostname to service  http://web:80"
fi

if [[ $MIGRATE == 1 ]]; then
  say "Migrating data from this machine"
  for v in "${VOLUMES[@]}"; do docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1 \
    || { echo "No local volume ${PROJECT}_$v: nothing to migrate from here."; exit 1; }; done
  if rdocker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1; then
    echo "$HOST already has Marquee data; refusing to overwrite it. Remove those volumes first if you mean to."
    exit 1
  fi
  # Data was created with the old passwords, so the remote must keep using them.
  remote "cd ~/$DIR && sed -i -e '/^POSTGRES_PASSWORD=/d' -e '/^MEILI_MASTER_KEY=/d' .env"
  say "Stopping Marquee here so the copy is consistent"
  (cd "$HERE" && docker compose -p "$PROJECT" stop)
  for v in "${VOLUMES[@]}"; do
    say "  copying $v"
    docker run --rm -v "${PROJECT}_$v:/v:ro" alpine tar -C /v -czf - . \
      | remote "docker volume create --label com.docker.compose.project=$PROJECT --label com.docker.compose.volume=$v ${PROJECT}_$v >/dev/null && docker run --rm -i -v ${PROJECT}_$v:/v alpine tar -C /v -xzf -"
  done
fi

say "Building and starting on $HOST (the first build takes a few minutes)"
rdocker compose -p "$PROJECT" up -d --build --remove-orphans

say "Waiting for it to come up"
for _ in $(seq 1 60); do
  if curl -fsS "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
    echo
    say "Marquee is running"
    echo "  Friends: http://$HOST:$PORT  (via their invite links)"
    echo "  Admin:   http://$HOST:8081  (your network only; never forward this port on your router)"
    [[ $MIGRATE == 1 ]] && echo "  This machine's copy is stopped. Remove it with: docker compose -p $PROJECT down"
    exit 0
  fi
  sleep 3
done
echo "Didn't answer on http://$HOST:$PORT after 3 minutes. Logs: ssh $TARGET 'cd ~/$DIR && docker compose -p $PROJECT logs --tail 50'"
exit 1
