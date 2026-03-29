# Multiplayer Tic-Tac-Toe — Nakama

A production-ready, server-authoritative multiplayer Tic-Tac-Toe game built with **Nakama** (backend) and **React + Vite** (frontend).

---

## Live deployment

| | URL |
|---|---|
| **Game** | http://136.115.248.132 |
| **Nakama API** | http://136.115.248.132/v2/ |
| **GitHub** | https://github.com/MihirBindu/multiplayer-tictactoe |

---

## Repository layout

```
multiplayer-tictactoe/
├── docker-compose.yml      # Full-stack compose (frontend + backend)
├── .env                    # Root secrets for full-stack compose — NOT committed
├── scripts/
│   ├── setup-vm.sh         # One-shot VM provisioner (install Docker, clone, start)
│   └── update.sh           # Pull latest code and redeploy
├── frontend/               # React + Vite client
│   ├── Dockerfile          # Multi-stage build: Node build → Nginx serve
│   ├── nginx.conf          # Serves static files + proxies /v2/ and /ws to Nakama
│   └── src/
│       └── TicTacToe.jsx   # Self-contained game component (Nakama SDK, UI)
├── nakama/                 # Nakama server configuration & runtime
│   ├── docker-compose.yml  # Backend-only compose (dev / CI)
│   ├── local.yml           # Server config (ports, logger, session, runtime)
│   ├── .env                # Backend secrets — NOT committed
│   ├── .env.example        # Committed template — copy to .env and root .env
│   └── modules/
│       └── main.js         # JS runtime: match handler, RPCs, matchmaker hook
└── README.md
```

---

## Cloud deployment (GCP e2-micro — free tier)

### Architecture

```
Internet
  │
  ▼  port 80  (only public port)
Nginx  ─── /          → React app (static files from Vite build)
       ─── /v2/...    → Nakama:7350  (REST API + RPC, internal network)
       ─── /ws        → Nakama:7350  (WebSocket, match traffic)
                              │
                         Nakama server  (internal only)
                              │
                         PostgreSQL     (internal only)
```

### Step 1 — Create the VM on GCP

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **Compute Engine** → **VM Instances** → **Create Instance**
2. Settings:
   - **Name**: `tictactoe-vm`
   - **Region**: `us-central1` or `us-east1` (free-tier eligible regions)
   - **Machine type**: `e2-micro` (2 vCPU, 1 GB RAM — free tier)
   - **Boot disk**: Ubuntu 22.04 LTS, 30 GB standard persistent disk
   - **Firewall**: check **Allow HTTP traffic** (port 80)
3. Click **Create**
4. Reserve a **static external IP**: VPC Network → External IP Addresses → Reserve → attach to `tictactoe-vm`

### Step 2 — SSH into the VM

From the GCP console click **SSH** next to the VM, or from your terminal:

```bash
gcloud compute ssh tictactoe-vm --zone us-central1-a
```

### Step 3 — Push your code to GitHub first

From your **local machine** (before running the VM script):

```bash
# In the project root
git init
git add .
git commit -m "Initial commit — Phases A-E complete"

# Create a repo at github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/multiplayer-tictactoe.git
git push -u origin main
```

### Step 4 — Run the one-shot setup script on the VM

```bash
# On the VM — replace YOUR_USERNAME with your GitHub username
export REPO_URL=https://github.com/YOUR_USERNAME/multiplayer-tictactoe.git
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/multiplayer-tictactoe/main/scripts/setup-vm.sh | bash
```

The script will:
1. Update Ubuntu and install Docker
2. Clone the repository
3. **Prompt for production secrets** (auto-generates strong random values if you press Enter)
4. Write `.env` and `nakama/.env` with those secrets
5. Run `docker compose up --build -d`
6. Wait for all containers to become healthy
7. Print the public game URL

### Step 5 — Open the game

```
http://<VM_PUBLIC_IP>
```

Both players open this URL on any device. Auto Match, Create Room, and Browse Rooms all work over the public IP.

### Redeploying after code changes

```bash
# On the VM
cd ~/multiplayer-tictactoe
./scripts/update.sh
```

### Stopping / restarting

```bash
# On the VM
cd ~/multiplayer-tictactoe
sudo docker compose down          # stop, keep DB data
sudo docker compose down -v       # stop + wipe DB (fresh start)
sudo docker compose up -d         # start without rebuilding
sudo docker compose up --build -d # rebuild frontend + start
```

### View live logs

```bash
sudo docker compose logs -f              # all services
sudo docker compose logs -f nakama       # server game logic only
sudo docker compose logs -f tictactoe-frontend  # Nginx access log
```

---

## Local development

### Full-stack (identical to production)

```bash
# From the project root
cp nakama/.env.example .env
cp nakama/.env.example nakama/.env

docker compose up --build
# Open http://localhost
```

### Backend-only + hot-reload frontend

Use this when iterating on game logic or UI — faster rebuild cycle.

```bash
# Terminal 1 — backend
cd nakama
docker compose up --build

# Terminal 2 — frontend dev server
cd frontend
npm install    # first time only
npm run dev    # http://localhost:5173
```

`import.meta.env.DEV === true` in the Vite dev server → frontend connects directly to `localhost:7350` (bypasses Nginx).

### Run automated test scripts

```bash
# Nakama backend must be running on localhost:7350 (nakama/docker-compose.yml)
node nakama/test_phase_b.mjs   # move validation, win/draw/forfeit gates
node nakama/test_phase_c.mjs   # matchmaker pairing + room listing
```

---

## How to test multiplayer functionality

### Manual browser tests

#### Auto Match (two tabs)
1. Open `http://localhost` in a normal Chrome tab
2. Open `http://localhost` in a Chrome **Incognito** tab
3. Click **Auto Match** in both tabs within ~2 seconds
4. **Expected**: both tabs transition to a game board within 2 seconds; one shows `Your turn (X)`, the other shows `Opponent's turn (X)`
5. Click a cell on the X tab → cell fills on both tabs, turns swap

#### Create Room + Browse
1. Tab A: click **Create Room** → shows `Waiting for opponent… Room: XXXXXXXX`
2. Tab B: click **Browse Rooms** → room appears as `Room XXXXXXXX · 1/2`
3. Tab B: click **Join** → both boards appear, game starts

#### Win / Draw
- Play until one player gets three in a row → status shows `You win! 🎉` / `X wins`
- Fill all 9 cells with no winner → status shows `It's a draw!`
- Click **Play Again** → board resets, new game starts

#### Forfeit on disconnect
- While a game is in progress, close one tab
- The remaining tab shows `You win! 🎉` immediately (forfeit policy)

#### Reconnect
- While a game is in progress, refresh (F5) one tab
- The tab rejoins the match and restores the exact board state from the server

### Automated tests

```bash
# Both scripts exit 0 on success, print PASS/FAIL per assertion
node nakama/test_phase_b.mjs
node nakama/test_phase_c.mjs
```

---

## API reference

All endpoints are accessed through Nginx at `http://<host>/v2/`.

### Authentication

```
POST /v2/account/authenticate/device
Authorization: Basic base64(NAKAMA_SERVER_KEY:)
Content-Type: application/json

{ "id": "<device-uuid>", "create": true }
```

Returns a `token` (JWT session) and `refresh_token`.

### RPC endpoints

| RPC | Method | Path | Request | Response |
|-----|--------|------|---------|----------|
| Create match | POST | `/v2/rpc/create_match` | `{}` | `{ "match_id": "<uuid>" }` |
| List open rooms | POST | `/v2/rpc/list_matches` | `{}` | `{ "matches": [{ "match_id": "<uuid>", "players": 1 }] }` |

### WebSocket

```
ws://<host>/ws?token=<JWT>&lang=en&status=true
```

After connecting, join a match:
```json
{ "match_join": { "match_id": "<uuid>" } }
```

Send a move (op_code 1):
```json
{ "type": "move", "index": 4 }
```

Server broadcasts full state on every accepted move (op_code 1):
```json
{
  "board":         [null, "X", null, null, "X", null, null, null, null],
  "currentPlayer": "O",
  "seats":         { "X": "<userId>", "O": "<userId>" },
  "status":        "playing",
  "winner":        null
}
```

### Server move validation gates

The server silently drops any message that fails one of these checks (in order):

| Gate | Rule |
|------|------|
| 1 | Message is valid JSON |
| 2 | `type === "move"` |
| 3 | `status === "playing"` |
| 4 | Sender's `userId` is in `seats.X` or `seats.O` |
| 5 | Sender's mark matches `currentPlayer` |
| 6 | `index` is an integer in `[0, 8]` |
| 7 | `board[index] === null` |

---

## Ports reference

| Port | Exposed by | Service | Notes |
|------|-----------|---------|-------|
| **80** | full-stack / cloud | Nginx (frontend + proxy) | Only public port in production |
| 5432 | backend-only compose | PostgreSQL | Dev inspection only |
| 7349 | backend-only compose | Nakama gRPC API | Dev / test scripts |
| 7350 | backend-only compose | Nakama HTTP + WebSocket | Dev / test scripts |
| 7351 | backend-only compose | Nakama Developer Console | `admin` / `admin` |
| 5173 | `npm run dev` | Vite dev server | Frontend hot-reload |

---

## Environment variables

| Variable | Where | Default | Purpose |
|----------|-------|---------|---------|
| `POSTGRES_DB` | `.env` | `nakama` | Database name |
| `POSTGRES_USER` | `.env` | `nakama` | DB user |
| `POSTGRES_PASSWORD` | `.env` | `localdb` | DB password — **change in production** |
| `NAKAMA_SERVER_KEY` | `.env` | `defaultkey` | Client auth key — **change in production** |

`NAKAMA_SERVER_KEY` is passed to the Nakama container via `--socket.server_key` CLI flag and baked into the frontend JS bundle as `VITE_NK_KEY` at Docker build time. Both values must match.

---

## Architecture & design decisions

- **Server-authoritative**: all game state lives in `modules/main.js`. The client only sends move intent and renders the server-broadcast state. Zero game logic in the frontend.
- **Nginx reverse proxy**: in production the browser never talks to Nakama directly. Nginx serves the React app and proxies `/v2/` (REST/RPC) and `/ws` (WebSocket) on the same origin — no CORS configuration needed.
- **JavaScript runtime**: chosen over Lua/Go plugin for zero-build-step iteration alongside the React frontend.
- **Single `.env.example`**: one template file drives both the full-stack compose (root `.env`) and backend-only compose (`nakama/.env`). Same variables, same values.
- **`sessionStorage` for device ID**: each browser tab gets a unique Nakama identity, enabling multi-tab matchmaking tests on a single machine.
- **`useRef` for match ID**: guards against a race condition where the server's `status: playing` broadcast arrives before React's `setMatchId` state update, which would silently drop the first click.
- **Disconnect = forfeit**: if a player disconnects while `status === "playing"`, the opponent is immediately declared winner. The match is not re-joinable (by design — simple, deterministic policy).
