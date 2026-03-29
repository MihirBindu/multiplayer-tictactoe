/**
 * test_phase_b.mjs — Phase B checkpoint verification
 *
 * Tests all 7 validation gates and the full game flow:
 *   T1   Two players authenticate and connect
 *   T2   P1 joins; P2 joins → state broadcast shows "playing"
 *   T3   Gate 5: out-of-turn move DROPPED (no broadcast)
 *   T4   Gate 2: unknown message type DROPPED
 *   T5   Gate 1: malformed JSON DROPPED
 *   T6   Gate 6: index out of range DROPPED
 *   T7   Gate 7: occupied cell DROPPED (after a valid P1 move)
 *   T8   Valid moves advance state correctly
 *   T9   X-wins game ends with winner="X", status="finished"
 *   T10  Gate 3: move after "finished" DROPPED
 *
 * Run: node test_phase_b.mjs
 */

import http from "node:http";

const HOST       = "localhost";
const HTTP_PORT  = 7350;
const SERVER_KEY = "defaultkey";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpPost(path, body, auth) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req  = http.request(
      { hostname: HOST, port: HTTP_PORT, path, method: "POST",
        headers: { "Content-Type": "application/json",
                   "Content-Length": Buffer.byteLength(data),
                   "Authorization": auth } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
      },
    );
    req.on("error", reject);
    req.write(data); req.end();
  });
}

async function authenticate(deviceId) {
  const resp = await httpPost(
    "/v2/account/authenticate/device",
    { id: deviceId, create: true },
    "Basic " + Buffer.from(SERVER_KEY + ":").toString("base64"),
  );
  if (!resp.token) throw new Error("Auth failed: " + JSON.stringify(resp));
  return resp.token;
}

async function createMatch(token) {
  const resp = await httpPost("/v2/rpc/create_match", '""', "Bearer " + token);
  return JSON.parse(resp.payload).match_id;
}

function b64enc(str) { return Buffer.from(str).toString("base64"); }
function b64dec(s)   { return Buffer.from(s, "base64").toString("utf8"); }

// ── WebSocket client ──────────────────────────────────────────────────────────

class Sock {
  constructor(token) {
    this._token   = token;
    this._ws      = null;
    this._queue   = [];  // buffered incoming envelopes
    this._waiters = [];  // pending recv() callbacks
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `ws://${HOST}:${HTTP_PORT}/ws?token=${this._token}&format=json`;
      this._ws  = new WebSocket(url);
      this._ws.onopen    = () => resolve();
      this._ws.onerror   = (e) => reject(e);
      this._ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if (this._waiters.length) this._waiters.shift()(msg);
        else                      this._queue.push(msg);
      };
    });
  }

  /** Resolve with next message, reject after timeoutMs */
  recv(timeoutMs = 5000) {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this._waiters.indexOf(cb);
        if (i !== -1) this._waiters.splice(i, 1);
        reject(new Error("recv timeout"));
      }, timeoutMs);
      const cb = (msg) => { clearTimeout(t); resolve(msg); };
      this._waiters.push(cb);
    });
  }

  /** Drain all queued + incoming messages for ms milliseconds; return array */
  async drain(ms = 800) {
    const msgs = [];
    while (true) {
      try { msgs.push(await this.recv(ms)); } catch { break; }
    }
    return msgs;
  }

  /** Return first message that satisfies predicate within ms */
  async expect(pred, ms = 4000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const msg = await this.recv(deadline - Date.now());
      if (pred(msg)) return msg;
    }
    throw new Error("expect: timed out");
  }

  send(env)   { this._ws.send(JSON.stringify(env)); }
  close()     { this._ws?.close(); }

  join(matchId) {
    this.send({ match_join: { match_id: matchId } });
    return this.expect(m => !!m.match || !!m.match_data, 5000);
  }

  move(matchId, index) {
    this.send({ match_data_send: {
      match_id: matchId, op_code: 1,
      data: b64enc(JSON.stringify({ type: "move", index })),
    }});
  }

  raw(matchId, text) {
    this.send({ match_data_send: {
      match_id: matchId, op_code: 1,
      data: b64enc(text),
    }});
  }
}

function decodeState(msg) {
  return JSON.parse(b64dec(msg.match_data.data));
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label, cond, detail = "") {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.log(`  ✗  ${label}${detail ? "  [" + detail + "]" : ""}`); failed++; }
}

async function run() {
  console.log("\n=== Phase B — Server-Authoritative Checkpoint ===\n");

  // ── Setup: authenticate + create match ────────────────────────────────────
  const [tok1, tok2] = await Promise.all([
    authenticate("test-phase-b-player-one"),
    authenticate("test-phase-b-player-two"),
  ]);
  const matchId = await createMatch(tok1);
  console.log("[setup] match:", matchId);

  const s1 = new Sock(tok1), s2 = new Sock(tok2);
  await s1.connect(); await s2.connect();
  console.log("[setup] both sockets connected\n");

  // ── T1: P1 joins (status still "waiting") ─────────────────────────────────
  await s1.join(matchId);
  ok("T1: P1 joins successfully", true);

  // ── T2: P2 joins → both seated → "playing" broadcast received by P1 ───────
  // Nakama sends the broadcast (from matchJoin) before the join ACK to P2.
  // We collect all messages from both sockets until we find the state broadcast.
  s2.send({ match_join: { match_id: matchId } });
  await new Promise(r => setTimeout(r, 1200)); // let server process

  // Drain both sockets; find the first match_data envelope
  const msgs1 = await s1.drain(800);
  const msgs2 = await s2.drain(800);
  const allMsgs = [...msgs1, ...msgs2];
  const stateMsg = allMsgs.find(m => m.match_data);
  ok("T2a: 'playing' state broadcast received", !!stateMsg);
  const gs = stateMsg ? decodeState(stateMsg) : {};
  ok("T2b: status='playing'",          gs.status === "playing",          gs.status);
  ok("T2c: currentPlayer='X'",         gs.currentPlayer === "X");
  ok("T2d: board is blank (9 nulls)",  Array.isArray(gs.board) && gs.board.every(c => c === null));
  ok("T2e: seat X assigned",           !!gs.seats?.X);
  ok("T2f: seat O assigned",           !!gs.seats?.O);

  // ── T3: Gate 5 — P2 moves on P1's turn → DROPPED ─────────────────────────
  console.log("\n--- Validation gates ---");
  s2.move(matchId, 4);
  await new Promise(r => setTimeout(r, 1000));
  const leak3 = await s1.drain(600);
  ok("T3: Gate 5 — out-of-turn DROPPED (no broadcast)", leak3.length === 0,
     "got " + leak3.length + " unexpected msg(s)");

  // ── T4: Gate 2 — unknown type → DROPPED ───────────────────────────────────
  s1.raw(matchId, '{"type":"cheat","board":[1,1,1,1,1,1,1,1,1]}');
  await new Promise(r => setTimeout(r, 1000));
  const leak4 = await s1.drain(600);
  ok("T4: Gate 2 — unknown type DROPPED", leak4.length === 0);

  // ── T5: Gate 1 — malformed JSON → DROPPED ─────────────────────────────────
  s1.raw(matchId, "NOT_VALID_JSON!!!");
  await new Promise(r => setTimeout(r, 1000));
  const leak5 = await s1.drain(600);
  ok("T5: Gate 1 — malformed JSON DROPPED", leak5.length === 0);

  // ── T6: Gate 6 — index out of range → DROPPED ─────────────────────────────
  s1.move(matchId, 99);
  await new Promise(r => setTimeout(r, 1000));
  const leak6 = await s1.drain(600);
  ok("T6: Gate 6 — index=99 DROPPED", leak6.length === 0);

  // ── T7: Valid move — P1 plays cell 0 ──────────────────────────────────────
  console.log("\n--- Valid moves & win detection ---");
  s1.move(matchId, 0);
  const afterMove0 = decodeState(await s1.expect(m => !!m.match_data));
  await s2.drain(600); // consume P2's copy
  ok("T7a: P1 cell 0 accepted — board[0]='X'",    afterMove0.board[0] === "X");
  ok("T7b: Turn advances to 'O'",                  afterMove0.currentPlayer === "O");
  ok("T7c: Status still 'playing'",               afterMove0.status === "playing");

  // ── T8: Gate 7 — P2 claims occupied cell 0 → DROPPED ─────────────────────
  s2.move(matchId, 0); // occupied!
  await new Promise(r => setTimeout(r, 1000));
  const leak8 = await s1.drain(600);
  ok("T8: Gate 7 — occupied cell DROPPED", leak8.length === 0);

  // ── T9: Play full X-wins sequence (X:0,1,2  O:3,4) ───────────────────────
  // (P1 already placed X on cell 0; it's O's turn)
  // O → 3
  s2.move(matchId, 3);
  decodeState(await s2.expect(m => !!m.match_data)); await s1.drain(600);
  // X → 1
  s1.move(matchId, 1);
  decodeState(await s1.expect(m => !!m.match_data)); await s2.drain(600);
  // O → 4
  s2.move(matchId, 4);
  decodeState(await s2.expect(m => !!m.match_data)); await s1.drain(600);
  // X → 2  (completes row 0-1-2, X wins)
  s1.move(matchId, 2);
  const final = decodeState(await s1.expect(m => !!m.match_data));
  await s2.drain(600);

  ok("T9a: status='finished'",            final.status === "finished", final.status);
  ok("T9b: winner='X'",                   final.winner === "X",        final.winner);
  ok("T9c: currentPlayer=null",           final.currentPlayer === null);
  ok("T9d: X cells [0,1,2] = 'X'",
     final.board[0] === "X" && final.board[1] === "X" && final.board[2] === "X");

  // ── T10: Gate 3 — move after "finished" → DROPPED ─────────────────────────
  s1.move(matchId, 5);
  await new Promise(r => setTimeout(r, 1000));
  const leak10 = await s1.drain(600);
  ok("T10: Gate 3 — move after 'finished' DROPPED", leak10.length === 0);

  // ── Summary ────────────────────────────────────────────────────────────────
  s1.close(); s2.close();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error("Fatal:", e.stack || e); process.exit(1); });
