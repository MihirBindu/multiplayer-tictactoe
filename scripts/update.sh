#!/usr/bin/env bash
# =============================================================================
# update.sh — Pull latest code and redeploy the stack (zero-downtime for DB)
#
# Run on the VM whenever you push new code to the repository:
#   cd ~/multiplayer-tictactoe && ./scripts/update.sh
# =============================================================================

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_CMD="sudo docker compose"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

cd "$APP_DIR"

# ── Pull latest code ──────────────────────────────────────────────────────────
info "Pulling latest code from origin..."
git pull

# ── Rebuild and restart only changed services ─────────────────────────────────
# --build   → rebuild images that changed (frontend, if code changed)
# --no-deps → don't restart postgres/nakama if only frontend changed
# We restart all to keep things simple and consistent.
info "Rebuilding and restarting services..."
$COMPOSE_CMD up --build -d

# ── Show status ───────────────────────────────────────────────────────────────
info "Current container status:"
sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "<VM_PUBLIC_IP>")
echo ""
echo -e "  Game URL: ${GREEN}http://${PUBLIC_IP}${NC}"
echo ""
info "Update complete. View logs: sudo docker compose logs -f"
