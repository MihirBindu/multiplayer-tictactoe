// =============================================================================
// main.js — Nakama JS runtime entry point (single bundled file)
//
// Loaded via: runtime.js_entrypoint = "main.js" in local.yml.
// Nakama loads ONLY this file; all game code must live here.
//
// IMPORTANT — Nakama JS runtime constraint:
//   registerMatch() requires each handler to be a TOP-LEVEL named function
//   declaration (function foo() {}). Inline function literals inside an object
//   literal are rejected with "javascript functions cannot be inlined".
//   Therefore every handler is declared at module scope and then referenced
//   by name in the registration object.
//
// Structure
//   § 1  Constants & op codes     (frozen — never change in v1)
//   § 2  Win-line table           (pure data)
//   § 3  Pure helpers             (no Nakama API, no side effects)
//   § 4  Match handler functions  (top-level, named — Nakama requirement)
//   § 5  RPC handlers             (thin wrappers — no game logic)
//   § 6  Matchmaker hook          (matchmakerMatched — creates match, no game logic)
//   § 7  InitModule               (registration only — no game logic)
//
// ── Disconnect policy (v1 — frozen, do not change mid-project) ───────────────
//   A player who disconnects while status === "playing" forfeits immediately.
//   The opponent is declared the winner. The match is NOT re-joinable.
//
// ── Broadcast pattern (frozen) ───────────────────────────────────────────────
//   Always broadcast the FULL state object after every state change.
//   Op code OP_STATE (1) is used for every server → client message.
//
// ── Client message schema v1 (frozen) ────────────────────────────────────────
//   { "type": "move", "index": <integer 0-8> }
//   Any other type is silently dropped with a server-side WARN log.
// =============================================================================


// =============================================================================
// § 1  Constants & op codes
// =============================================================================

var OP_STATE = 1; // server → clients: full game state


// =============================================================================
// § 2  Win-line table
// =============================================================================

var WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];


// =============================================================================
// § 3  Pure helpers — no Nakama API, no side effects
// =============================================================================

/**
 * Scan the board for a winner or draw.
 * Called exactly ONCE per accepted move, only from matchLoop.
 *
 * @param  {Array<null|"X"|"O">} board  Length-9 array.
 * @returns {"X"|"O"|"draw"|null}  null = game still in progress.
 */
function computeOutcome(board) {
  for (var i = 0; i < WIN_LINES.length; i++) {
    var line = WIN_LINES[i];
    var a = board[line[0]], b = board[line[1]], c = board[line[2]];
    if (a !== null && a === b && a === c) {
      return a; // "X" or "O"
    }
  }
  for (var j = 0; j < board.length; j++) {
    if (board[j] === null) return null; // empty cell exists — game on
  }
  return "draw";
}

/**
 * Return a brand-new, empty game state.
 * Call once per match in matchInit only.
 */
function freshState() {
  return {
    board:         [null, null, null, null, null, null, null, null, null],
    currentPlayer: "X",                  // "X" always moves first
    seats:         { X: null, O: null }, // value: userId string | null
    status:        "waiting",            // "waiting" | "playing" | "finished"
    winner:        null,                 // null | "X" | "O" | "draw"
  };
}


// =============================================================================
// § 4  Match handler functions (top-level, named — required by Nakama JS runtime)
// =============================================================================

// ---------------------------------------------------------------------------
// matchInit — called once when nk.matchCreate("tictactoe", {}) is invoked
// ---------------------------------------------------------------------------
function matchInit(ctx, logger, nk, params) {
  logger.info("TicTacToe match initialised");
  return {
    state:    freshState(),
    tickRate: 1,               // matchLoop fires 1×/second
    label:    '{"open":true}', // discoverable by matchmaker (Phase C)
  };
}

// ---------------------------------------------------------------------------
// matchJoinAttempt — gate before a presence is admitted; accept or reject
// ---------------------------------------------------------------------------
function matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  if (state.status === "finished") {
    return { state: state, accept: false, rejectMessage: "Match has ended" };
  }
  if (state.seats.X !== null && state.seats.O !== null) {
    return { state: state, accept: false, rejectMessage: "Match is full" };
  }
  return { state: state, accept: true };
}

// ---------------------------------------------------------------------------
// matchJoin — called after presences are admitted; assign seats, start game
//
// Seat assignment: first joiner → X, second → O.
// When both seats are filled for the first time: status → "playing", broadcast.
// ---------------------------------------------------------------------------
function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    if (state.seats.X === null) {
      state.seats.X = p.userId;
      logger.info("Seat X → " + p.userId);
    } else if (state.seats.O === null) {
      state.seats.O = p.userId;
      logger.info("Seat O → " + p.userId);
    }
  }

  if (state.seats.X !== null && state.seats.O !== null && state.status === "waiting") {
    state.status = "playing";
    try { dispatcher.matchLabelUpdate('{"open":false}'); } catch (_) {}
    logger.info("Both players seated — game started");
    dispatcher.broadcastMessage(OP_STATE, JSON.stringify(state), null, null, true);
  }

  return { state: state };
}

// ---------------------------------------------------------------------------
// matchLeave — called on disconnect or explicit leave
//
// Disconnect policy v1 (frozen — see file header):
//   status === "playing"  →  forfeiting player loses; opponent wins; finished.
//   status !== "playing"  →  clear seat; match stays alive.
// ---------------------------------------------------------------------------
function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    logger.info("Player left: " + p.userId);

    if (state.status === "playing") {
      var forfeitWinner = null;
      if      (state.seats.X === p.userId) { forfeitWinner = "O"; state.seats.X = null; }
      else if (state.seats.O === p.userId) { forfeitWinner = "X"; state.seats.O = null; }

      if (forfeitWinner !== null) {
        state.status        = "finished";
        state.winner        = forfeitWinner;
        state.currentPlayer = null;
        logger.info("Forfeit declared — winner: " + forfeitWinner);
        dispatcher.broadcastMessage(OP_STATE, JSON.stringify(state), null, null, true);
      }
    } else {
      if      (state.seats.X === p.userId) state.seats.X = null;
      else if (state.seats.O === p.userId) state.seats.O = null;
    }
  }
  return { state: state };
}

// ---------------------------------------------------------------------------
// matchLoop — called every tick (1 Hz); processes validated move messages
//
// Validation gates (ordered — any failure → drop + WARN, no state change):
//   1. Parseable JSON
//   2. type === "move"
//   3. status === "playing"
//   4. Sender is a seated player
//   5. It is the sender's turn  (senderMark === currentPlayer)
//   6. index is an integer in [0, 8]
//   7. board[index] is null  (cell is empty)
//
// Apply path (only after all 7 gates pass):
//   board[index] ← senderMark
//   computeOutcome(board)       ← called exactly once per accepted move
//   broadcast full state        ← always, after every accepted move
// ---------------------------------------------------------------------------
function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  if (!messages || messages.length === 0) {
    return { state: state };
  }

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];

    // ── Gate 1: parseable JSON ──────────────────────────────────────────────
    var data;
    try {
      var raw = (typeof msg.data === "string") ? msg.data : nk.binaryToString(msg.data);
      data    = JSON.parse(raw);
    } catch (e) {
      logger.warn("[DROPPED] Unparseable message from " + msg.sender.userId);
      continue;
    }

    // ── Gate 2: known message type ──────────────────────────────────────────
    if (data.type !== "move") {
      logger.warn("[DROPPED] Unknown type '" + data.type + "' from " + msg.sender.userId);
      continue;
    }

    // ── Gate 3: game must be in progress ────────────────────────────────────
    if (state.status !== "playing") {
      logger.warn("[DROPPED] Move rejected — status=" + state.status);
      continue;
    }

    // ── Gate 4: sender must be a seated player ──────────────────────────────
    var senderMark = null;
    if      (state.seats.X === msg.sender.userId) senderMark = "X";
    else if (state.seats.O === msg.sender.userId) senderMark = "O";
    if (senderMark === null) {
      logger.warn("[DROPPED] " + msg.sender.userId + " not a seated player");
      continue;
    }

    // ── Gate 5: must be sender's turn ──────────────────────────────────────
    if (senderMark !== state.currentPlayer) {
      logger.warn("[DROPPED] Out-of-turn from " + msg.sender.userId +
                  " (expected " + state.currentPlayer + ")");
      continue;
    }

    // ── Gate 6: index must be integer in [0, 8] ─────────────────────────────
    var idx = data.index;
    if (typeof idx !== "number" || idx !== Math.floor(idx) || idx < 0 || idx > 8) {
      logger.warn("[DROPPED] Invalid index: " + JSON.stringify(idx));
      continue;
    }

    // ── Gate 7: cell must be empty ──────────────────────────────────────────
    if (state.board[idx] !== null) {
      logger.warn("[DROPPED] Cell " + idx + " occupied by " + state.board[idx]);
      continue;
    }

    // ── Apply move ──────────────────────────────────────────────────────────
    state.board[idx] = senderMark;

    // ── Recompute outcome — single call, only here, only after apply ─────────
    var outcome = computeOutcome(state.board);
    if (outcome !== null) {
      state.status        = "finished";
      state.winner        = outcome;  // "X" | "O" | "draw"
      state.currentPlayer = null;
    } else {
      state.currentPlayer = (senderMark === "X") ? "O" : "X";
    }

    // ── Broadcast FULL state (frozen pattern — every accepted move) ──────────
    dispatcher.broadcastMessage(OP_STATE, JSON.stringify(state), null, null, true);

    logger.info(
      "[MOVE] " + senderMark + " → cell " + idx +
      " | next=" + (state.currentPlayer || "—") +
      " | outcome=" + (outcome || "none")
    );
  }

  return { state: state };
}

// ---------------------------------------------------------------------------
// matchTerminate — Nakama is shutting down or killing this match
// ---------------------------------------------------------------------------
function matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  logger.info("Match terminating — grace: " + graceSeconds + "s");
  dispatcher.broadcastMessage(
    OP_STATE,
    JSON.stringify({ status: "terminated" }),
    null, null, true
  );
  return { state: state };
}

// ---------------------------------------------------------------------------
// matchSignal — admin signal via API; not used in normal game flow
// ---------------------------------------------------------------------------
function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
  return { state: state, data: "" };
}


// =============================================================================
// § 5  RPC handlers — thin wrappers; no game logic
// =============================================================================

/**
 * create_match RPC
 * Creates one authoritative "tictactoe" match and returns its ID.
 * Clients call this to get a match_id before connecting via socket.
 *
 * Request payload: ignored (send "" or "{}")
 * Response:        { "match_id": "<uuid>" }
 */
function rpcCreateMatch(ctx, logger, nk, payload) {
  var matchId = nk.matchCreate("tictactoe", {});
  logger.info("RPC create_match — created: " + matchId);
  return JSON.stringify({ match_id: matchId });
}

/**
 * list_matches RPC
 * Returns authoritative matches currently waiting for a second player
 * (label.open === true, 0–1 seated players).
 * Clients use this for room-discovery before joining an existing game.
 *
 * Request payload: ignored
 * Response:        { "matches": [{ "match_id": "...", "players": N }] }
 */
function rpcListMatches(ctx, logger, nk, payload) {
  // List up to 10 authoritative matches with 0–1 players (waiting room).
  // Label filter: only matches whose label contains "open":true.
  var found = nk.matchList(10, true, null, 0, 1, null);
  var open  = [];
  for (var i = 0; i < found.length; i++) {
    var m = found[i];
    try {
      if (JSON.parse(m.label || "{}").open === true) {
        open.push({ match_id: m.matchId, players: m.size });
      }
    } catch (_) {}
  }
  return JSON.stringify({ matches: open });
}


// =============================================================================
// § 6  Matchmaker hook — no game logic; only creates the match
// =============================================================================

/**
 * matchmakerMatched
 * Called by Nakama when the matchmaker pairs exactly 2 players whose
 * addMatchmaker() properties satisfy the query.
 *
 * Flow (automatic matchmaking):
 *   1. Client A: socket.addMatchmaker("+properties.game_mode:classic", 2, 2, { game_mode: "classic" })
 *   2. Client B: same call
 *   3. Nakama calls this hook → creates one "tictactoe" match → returns matchId
 *   4. Both clients receive matchmaker_matched with the match_id and join.
 *
 * The match they join is the SAME authoritative handler as the create+join flow.
 * No game logic lives here.
 *
 * @param {nkruntime.MatchmakerResult[]} matches  Exactly 2 entries (min/max = 2).
 * @returns {string}  The match ID to hand to both matched clients.
 */
function matchmakerMatched(ctx, logger, nk, matches) {
  var matchId = nk.matchCreate("tictactoe", {});
  logger.info(
    "Matchmaker paired " + matches.length + " players → " + matchId
  );
  return matchId;
}


// =============================================================================
// § 7  InitModule — registration only; zero game logic
// =============================================================================

/**
 * Called exactly once by Nakama when the JS runtime starts.
 * Registers all handlers by NAME — no game logic lives here.
 *
 * § 4 match handler   → registerMatch("tictactoe", ...)
 * § 5 RPCs            → registerRpc("create_match"), registerRpc("list_matches")
 * § 6 matchmaker hook → registerMatchmakerMatched(matchmakerMatched)
 */
var InitModule = function (ctx, logger, nk, initializer) {
  logger.info("=== TicTacToe: Nakama module loaded (Phase C) ===");

  // ── § 4  Authoritative match handler ─────────────────────────────────────
  initializer.registerMatch("tictactoe", {
    matchInit:        matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin:        matchJoin,
    matchLeave:       matchLeave,
    matchLoop:        matchLoop,
    matchTerminate:   matchTerminate,
    matchSignal:      matchSignal,
  });

  // ── § 5  RPC endpoints ────────────────────────────────────────────────────
  initializer.registerRpc("create_match", rpcCreateMatch);
  initializer.registerRpc("list_matches", rpcListMatches);

  // ── § 6  Matchmaker hook ──────────────────────────────────────────────────
  initializer.registerMatchmakerMatched(matchmakerMatched);
};
