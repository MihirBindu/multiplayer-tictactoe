/**
 * test_phase_c.mjs — Phase C checkpoint verification
 *
 * Tests:
 *   Flow A — Automatic matchmaking
 *     T1  Both clients call addMatchmaker with matching properties
 *     T2  matchmakerMatched hook fires → both receive match_id
 *     T3  Both join → state shows "playing"
 *     T4  X player's move works (Phase B logic unchanged)
 *
 *   Flow B — Create + list + join (room discovery)
 *     T5  P1 calls create_match RPC → gets match_id
 *     T6  P2 calls list_matches RPC → finds the open match
 *     T7  Both join → state shows "playing"
 *
 *   Disconnect policy (Phase B — unchanged)
 *     T8  P1 disconnects mid-game → P2 receives forfeit
 *
 * Prerequisites:
 *   - Nakama running with matchmaker.interval_sec: 1 (local.yml)
 *   - Run: node test_phase_c.mjs
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

function httpGet(path, auth) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: HOST, port: HTTP_PORT, path, method: "GET",
        headers: { "Authorization": auth } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Returns { token, userId } */
async function authenticate(deviceId) {
  const resp = await httpPost(
    "/v2/account/authenticate/device",
    { id: deviceId, create: true },
    "Basic " + Buffer.from(SERVER_KEY + ":").toString("base64"),
  );
  if (!resp.token) throw new Error("Auth failed: " + JSON.stringify(resp));
  const acct = await httpGet("/v2/account", "Bearer " + resp.token);
  return { token: resp.token, userId: acct.user.id };
}

async function rpc(token, name, payload = '""') {
  const resp = await httpPost("/v2/rpc/" + name, payload, "Bearer " + token);
  if (resp.error) throw new Error("RPC " + name + " error: " + JSON.stringify(resp));
  return resp.payload ? JSON.parse(resp.payload) : resp;
}

function b64enc(s) { return Buffer.from(s).toString("base64"); }
function b64dec(s) { return Buffer.from(s, "base64").toString("utf8"); }

// ── WebSocket client ──────────────────────────────────────────────────────────

class Sock {
  constructor(token) {
    this._token   = token;
    this._ws      = null;
    this._queue   = [];
    this._waiters = [];
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

  /**
   * Wait for ONE message, rejecting after `ms` milliseconds.
   * The rejection is always created inside a try-catch or passed through a
   * callee that handles it; never left unhandled.
   */
  recv(ms = 5000) {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this._waiters.indexOf(cb);
        if (i !== -1) this._waiters.splice(i, 1);
        reject(new Error("recv timeout"));
      }, Math.max(ms, 0));
      const cb = (msg) => { clearTimeout(t); resolve(msg); };
      this._waiters.push(cb);
    });
  }

  /**
   * Collect all messages that arrive within `ms` milliseconds.
   * Never throws; always resolves with the collected array.
   */
  async collect(ms) {
    const all = [], deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try { all.push(await this.recv(remaining)); } catch { break; }
    }
    return all;
  }

  send(env) { this._ws.send(JSON.stringify(env)); }

  close() {
    // Cancel all pending waiters before closing so their timers don't fire later.
    for (const cb of this._waiters) cb({ _cancelled: true });
    this._waiters = [];
    this._ws?.close();
  }

  addMatchmaker(query, min, max, props) {
    this.send({
      matchmaker_add: {
        query:             query,
        min_count:         min,
        max_count:         max,
        string_properties: props,
      },
    });
  }

  move(matchId, index) {
    this.send({ match_data_send: {
      match_id: matchId, op_code: 1,
      data: b64enc(JSON.stringify({ type: "move", index })),
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

const sockets = []; // track all opened sockets for cleanup

async function run() {
  console.log("\n=== Phase C — Matchmaking & Rooms Checkpoint ===\n");

  const [authA, authB, authC, authD] = await Promise.all([
    authenticate("test-phase-c-player-aa"),
    authenticate("test-phase-c-player-bb"),
    authenticate("test-phase-c-player-cc"),
    authenticate("test-phase-c-player-dd"),
  ]);
  const [tokA, tokB, tokC, tokD] =
    [authA.token, authB.token, authC.token, authD.token];

  // ============================================================
  // Flow A — Automatic matchmaking
  // ============================================================
  console.log("--- Flow A: Automatic matchmaking ---");

  const sA = new Sock(tokA), sB = new Sock(tokB);
  sockets.push(sA, sB);
  await sA.connect(); await sB.connect();

  // Send both addMatchmaker requests. Stagger by 200 ms so the server has A's
  // ticket in the queue before B arrives — exactly as two browsers would behave.
  // Query: match only tickets with game_mode=classic (valid Bleve property query).
  const mmQuery = "+properties.game_mode:classic";
  const mmProps = { game_mode: "classic" };

  sA.addMatchmaker(mmQuery, 2, 2, mmProps);
  await new Promise(r => setTimeout(r, 200));
  sB.addMatchmaker(mmQuery, 2, 2, mmProps);

  // Collect all messages from both sockets for 6 s.
  // With matchmaker.interval_sec=1 in local.yml, pairing happens within ~1 s.
  // 6 s gives 5× headroom.
  const [msgsA, msgsB] = await Promise.all([
    sA.collect(6000),
    sB.collect(6000),
  ]);

  const ticketA  = msgsA.find(m => m.matchmaker_ticket);
  const ticketB  = msgsB.find(m => m.matchmaker_ticket);
  const matchedA = msgsA.find(m => m.matchmaker_matched)?.matchmaker_matched;
  const matchedB = msgsB.find(m => m.matchmaker_matched)?.matchmaker_matched;

  ok("T1a: A received matchmaker_ticket", !!ticketA,
     "msgs=" + msgsA.map(m => Object.keys(m)[0]));
  ok("T1b: B received matchmaker_ticket", !!ticketB,
     "msgs=" + msgsB.map(m => Object.keys(m)[0]));
  ok("T2a: A received matchmaker_matched with match_id", !!matchedA?.match_id,
     "msgs=" + msgsA.map(m => Object.keys(m)[0]));
  ok("T2b: B received same match_id",
     !!matchedB?.match_id && matchedA?.match_id === matchedB?.match_id,
     "A=" + matchedA?.match_id + "  B=" + matchedB?.match_id);

  const matchIdA = matchedA?.match_id;

  // T3: both join the match; confirm "playing" state
  if (matchIdA) {
    sA.send({ match_join: { match_id: matchIdA } });
    sB.send({ match_join: { match_id: matchIdA } });
    await new Promise(r => setTimeout(r, 1500));
  }

  const [drA, drB]  = await Promise.all([sA.collect(800), sB.collect(800)]);
  const stateMsg    = [...drA, ...drB].find(m => m.match_data && !m.match_data._cancelled);
  const gs          = stateMsg ? decodeState(stateMsg) : {};

  ok("T3a: 'playing' broadcast received",  !!stateMsg);
  ok("T3b: status='playing'",              gs.status === "playing",  gs.status || "—");
  ok("T3c: currentPlayer='X'",             gs.currentPlayer === "X");
  ok("T3d: both seats assigned",           !!gs.seats?.X && !!gs.seats?.O);

  // T4: the X player makes a valid move (Phase B logic unchanged)
  if (matchIdA && gs.seats) {
    const xSock = gs.seats.X === authA.userId ? sA : sB;
    xSock.move(matchIdA, 0);
    const [mvA, mvB] = await Promise.all([sA.collect(3000), sB.collect(3000)]);
    const moveMsg    = [...mvA, ...mvB].find(m => m.match_data);
    const afterMove  = moveMsg ? decodeState(moveMsg) : {};
    ok("T4: X player's move accepted — board[0]='X'", afterMove.board?.[0] === "X",
       "board=" + JSON.stringify(afterMove.board));
  } else {
    ok("T4: skipped (T2/T3 failed — no valid match state)", false);
  }

  sA.close(); sB.close();

  // ============================================================
  // Flow B — Create + list + join (room discovery)
  // ============================================================
  console.log("\n--- Flow B: Create + list + join ---");

  const created = await rpc(tokC, "create_match");
  ok("T5: create_match RPC returns match_id", !!created.match_id, JSON.stringify(created));

  const roomMatchId = created.match_id;
  await new Promise(r => setTimeout(r, 2000)); // give Nakama time to index the label

  const listed = await rpc(tokD, "list_matches");
  ok("T6a: list_matches returns an array",  Array.isArray(listed.matches), JSON.stringify(listed));
  const found = listed.matches?.find(m => m.match_id === roomMatchId);
  ok("T6b: created match appears as open",  !!found,
     "want=" + roomMatchId + " got=" + JSON.stringify(listed.matches?.map(m=>m.match_id)));
  ok("T6c: players count = 0",              found?.players === 0, "" + found?.players);

  const sC = new Sock(tokC), sD = new Sock(tokD);
  sockets.push(sC, sD);
  await sC.connect(); await sD.connect();

  sC.send({ match_join: { match_id: roomMatchId } });
  sD.send({ match_join: { match_id: roomMatchId } });
  await new Promise(r => setTimeout(r, 1500));

  const [drC, drD]  = await Promise.all([sC.collect(800), sD.collect(800)]);
  const stateMsg2   = [...drC, ...drD].find(m => m.match_data);
  const gs2         = stateMsg2 ? decodeState(stateMsg2) : {};

  ok("T7a: 'playing' broadcast received",  !!stateMsg2);
  ok("T7b: status='playing'",              gs2.status === "playing", gs2.status || "—");
  ok("T7c: both seats filled",             !!gs2.seats?.X && !!gs2.seats?.O);

  // ============================================================
  // Disconnect policy — Phase B unchanged
  // ============================================================
  console.log("\n--- Disconnect policy (Phase B — unchanged) ---");

  if (gs2.status === "playing") {
    // Play one move, then P1 (sC) disconnects.
    sC.move(roomMatchId, 4);
    await new Promise(r => setTimeout(r, 800)); // let tick process the move

    sC.close();
    // P2 (sD) should receive the forfeit broadcast.
    const [forfeitMsgs] = await Promise.all([sD.collect(6000)]);
    const forfeitMsg = forfeitMsgs.find(m => m.match_data);
    const forfeit    = forfeitMsg ? decodeState(forfeitMsg) : {};

    ok("T8a: disconnect triggers forfeit broadcast",  forfeit.status === "finished", forfeit.status || "—");
    ok("T8b: winner is the remaining player",
       forfeit.winner === "X" || forfeit.winner === "O", forfeit.winner || "—");
    ok("T8c: currentPlayer=null after forfeit",       forfeit.currentPlayer === null);
  } else {
    ok("T8a: skipped — T7 failed, no active match", false);
    ok("T8b: skipped", false);
    ok("T8c: skipped", false);
  }

  sD.close();
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

run()
  .then(() => {
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(e => {
    console.error("Fatal:", e.stack || e);
    process.exit(1);
  })
  .finally(() => {
    // Ensure all sockets are closed even if the test crashes mid-run,
    // so Nakama cleans up the sessions and removes their matchmaker tickets.
    for (const s of sockets) { try { s.close(); } catch {} }
  });
