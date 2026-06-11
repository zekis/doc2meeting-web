#!/usr/bin/env bash
# deploy.sh — Safe deploy script for doc2meeting production server.
# Pulls pre-built images from ghcr.io and restarts services with memory limits.
#
# Usage:
#   ./scripts/deploy.sh           # Pull latest + restart
#   ./scripts/deploy.sh --build   # Build locally (fallback, with memory limits)
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$COMPOSE_DIR"

COMPOSE_PROD="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

log() { echo "[deploy] $(date '+%H:%M:%S') $*"; }

if [[ "${1:-}" == "--build" ]]; then
    log "Local build mode (fallback) — stopping services first to free memory"
    docker compose down --remove-orphans
    log "Building backend with memory limit..."
    docker build --memory 2g -t ghcr.io/zekis/doc2meeting-web/backend:latest ./backend
    log "Building frontend with memory limit..."
    docker build --memory 2g -t ghcr.io/zekis/doc2meeting-web/frontend:latest ./frontend
    log "Starting services..."
    $COMPOSE_PROD up -d --remove-orphans
else
    log "Pulling pre-built images from ghcr.io..."
    $COMPOSE_PROD pull backend worker frontend
    log "Restarting services..."
    $COMPOSE_PROD up -d --remove-orphans
fi

log "Pruning dangling images..."
docker image prune -f

log "Service status:"
$COMPOSE_PROD ps

log "Done."
