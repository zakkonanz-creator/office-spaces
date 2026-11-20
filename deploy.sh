#!/bin/zsh
# Deploy to Railway. One Railway project, up to three services built from this repo:
#
#   ./deploy.sh               the app (this folder: web + API + office sockets)
#   ./deploy.sh livekit       the media server (deploy/livekit, ICE/TCP through a Railway TCP proxy)
#   ./deploy.sh transcriber   the Whisper service (transcriber/), optional
#   ENVIRONMENT=staging ./deploy.sh crowd   load-test bots (loadtest/), staging only
#
# First time: `railway login`, then run this; it asks which project/service to link.
# Set RAILWAY_WORKSPACE to have it refuse to deploy into any other workspace.
#
# Files are staged in ~/.railway-stage first, so each service uploads only what it needs.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-app}"
ENVIRONMENT="${ENVIRONMENT:-production}"
PROJECT="${RAILWAY_PROJECT:-office-spaces}"
if [ "$TARGET" = "crowd" ] && [ "$ENVIRONMENT" = "production" ]; then
  echo "!! the load-test crowd signs in with the dev login; it only runs against staging" >&2
  exit 1
fi
STAGE="$HOME/.railway-stage/$PROJECT-$TARGET-$ENVIRONMENT"
mkdir -p "$STAGE"

if [ "$TARGET" = "livekit" ]; then
  cp "$HERE"/deploy/livekit/* "$STAGE/"
elif [ "$TARGET" = "crowd" ]; then
  mkdir -p "$STAGE/media"
  cp "$HERE"/loadtest/{crowd.ts,Dockerfile} "$STAGE/" && cp "$HERE"/loadtest/media/* "$STAGE/media/"
elif [ "$TARGET" = "transcriber" ]; then
  cp "$HERE"/transcriber/{app.py,requirements.txt,Dockerfile} "$STAGE/"
else
  rsync -a --delete --exclude node_modules --exclude web/dist --exclude .data --exclude .env --exclude transcriber \
    --exclude '.railway-linked' --exclude loadtest --exclude .git "$HERE/" "$STAGE/"
fi
cd "$STAGE"

if [ ! -f .railway-linked ]; then
  if [ -n "$RAILWAY_WORKSPACE" ]; then
    railway link --workspace "$RAILWAY_WORKSPACE" --project "$PROJECT" --service "$TARGET" --environment "$ENVIRONMENT"
  else
    railway link --project "$PROJECT" --service "$TARGET" --environment "$ENVIRONMENT"
  fi
  touch .railway-linked
fi
if [ -n "$RAILWAY_WORKSPACE" ] && ! railway status 2>/dev/null | grep -q "^Workspace: *$RAILWAY_WORKSPACE\$"; then
  echo "!! not linked to the $RAILWAY_WORKSPACE workspace — refusing to deploy" >&2
  railway status >&2 || true
  exit 1
fi
if ! railway status 2>/dev/null | grep -q "^Environment: *$ENVIRONMENT\$"; then
  echo "!! linked to a different environment than $ENVIRONMENT — refusing to deploy" >&2
  railway status >&2 || true
  exit 1
fi

railway up --detach --service "$TARGET"
echo "Deploying $TARGET. Health: app → /health · livekit → / (prints OK)"
