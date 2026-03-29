/**
 * TicTacToe.jsx — self-contained multiplayer UI
 *
 * Responsibilities:
 *   • Nakama session + WebSocket lifecycle (single useEffect)
 *   • Lobby: auto-matchmaker | create room | browse rooms
 *   • Game board: disabled when not your turn or game over
 *   • Player labels + match status sourced from server state only
 *   • Reconnect: rejoin saved match on reload; fall back to lobby on failure
 *
 * Zero game logic lives here — all validation and state transitions
 * happen in nakama/modules/main.js.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Client } from '@heroiclabs/nakama-js'
import './tictactoe.css'

// ── Nakama connection constants ────────────────────────────────────────────────
// In development (Vite dev server) the browser talks directly to Nakama on
// localhost:7350.  In production the same origin as the page is used — Nginx
// proxies /v2/ and /ws to the Nakama container on the internal Docker network.
const IS_DEV  = import.meta.env.DEV
const NK_HOST = IS_DEV ? 'localhost'                           : window.location.hostname
const NK_PORT = IS_DEV ? '7350'                                : (window.location.port || '80')
const NK_SSL  = !IS_DEV && window.location.protocol === 'https:'
const NK_KEY  = import.meta.env.VITE_NK_KEY || 'defaultkey'

// op_code used by the server for full-state broadcasts (OP_STATE in main.js)
const OP_STATE = 1

// Matchmaker query + properties — must match the server-side comment in main.js
const MM_QUERY = '+properties.game_mode:classic'
const MM_PROPS = { game_mode: 'classic' }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** UUID v4 — uses crypto.randomUUID() on HTTPS/localhost, falls back to
 *  Math.random() on plain HTTP (crypto.randomUUID requires a secure context). */
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

/** Stable device ID — created once per browser tab, persisted in sessionStorage.
 *  sessionStorage is per-tab so two windows get different IDs (required for
 *  matchmaking to pair them as separate users) and survives reloads within the
 *  same tab (required for reconnect to work). */
function getDeviceId() {
  const key = 'ttt_device_id'
  let id = sessionStorage.getItem(key)
  if (!id) {
    id = generateUUID()
    sessionStorage.setItem(key, id)
  }
  return id
}

/** Decode a Uint8Array coming from onmatchdata into a parsed JS object. */
function decodeState(u8) {
  try {
    return JSON.parse(new TextDecoder().decode(u8))
  } catch {
    return null
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TicTacToe() {
  // phase: connecting → lobby → waiting → playing → finished
  const [phase,    setPhase]    = useState('connecting')
  const [gs,       setGs]       = useState(null)   // full game state from server
  const [userId,   setUserId]   = useState(null)
  const [matchId,  setMatchId]  = useState(null)
  const [roomList, setRoomList] = useState(null)   // null = not browsing
  const [error,    setError]    = useState(null)

  const clientRef  = useRef(null)
  const socketRef  = useRef(null)
  const sessionRef = useRef(null)
  // matchIdRef mirrors matchId state but is always current — used in handleMove
  // to avoid stale-closure races where the board renders before setMatchId fires.
  const matchIdRef = useRef(null)

  // Derived from server state — never computed client-side
  const myMark   = gs?.seats?.X === userId ? 'X'
                 : gs?.seats?.O === userId ? 'O'
                 : null
  const isMyTurn = phase === 'playing' && gs?.currentPlayer === myMark

  // ── Connect to Nakama (once) ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true

    async function init() {
      try {
        const devId  = getDeviceId()
        const client = new Client(NK_KEY, NK_HOST, NK_PORT, NK_SSL)
        clientRef.current = client

        const session = await client.authenticateDevice(devId, true)
        if (!alive) return
        sessionRef.current = session
        setUserId(session.user_id)

        const sock = client.createSocket(NK_SSL, false)
        socketRef.current = sock

        // ── Server → client: full state broadcast ──────────────────────────
        sock.onmatchdata = (d) => {
          if (d.op_code !== OP_STATE || !alive) return
          const state = decodeState(d.data)
          if (!state) return
          setGs(state)
          if (state.status === 'playing')  setPhase('playing')
          if (state.status === 'finished') setPhase('finished')
          // 'waiting' state: phase stays as-is (lobby→waiting already set)
        }

        // ── Matchmaker paired two players → join the created match ──────────
        sock.onmatchmakermatched = async (matched) => {
          if (!alive) return
          const mid = matched.match_id
          if (!mid) return
          // Set ref + state BEFORE await so handleMove is never stale if
          // the server's "playing" broadcast arrives before joinMatch resolves.
          matchIdRef.current = mid
          setMatchId(mid)
          sessionStorage.setItem('ttt_match_id', mid)
          try {
            await sock.joinMatch(mid)
            // phase transitions to 'playing' when server broadcasts status
          } catch (e) {
            if (alive) {
              matchIdRef.current = null
              setMatchId(null)
              sessionStorage.removeItem('ttt_match_id')
              setError('Failed to join matched game: ' + e.message)
            }
          }
        }

        await sock.connect(session, true)
        if (!alive) return

        // ── Reconnect: try to rejoin previously saved match ─────────────────
        const saved = sessionStorage.getItem('ttt_match_id')
        if (saved) {
          matchIdRef.current = saved
          setMatchId(saved)
          try {
            await sock.joinMatch(saved)
            if (!alive) return
            setPhase('waiting')   // server will broadcast 'playing' if active
          } catch {
            // match ended or full — discard stale ID and go to lobby
            matchIdRef.current = null
            setMatchId(null)
            sessionStorage.removeItem('ttt_match_id')
            if (alive) setPhase('lobby')
          }
        } else {
          if (alive) setPhase('lobby')
        }
      } catch (e) {
        if (alive) setError(String(e?.message ?? e))
      }
    }

    init()

    return () => {
      alive = false
      socketRef.current?.disconnect(false)
    }
  }, []) // runs once on mount

  // ── Lobby actions ──────────────────────────────────────────────────────────

  const handleAutoMatch = useCallback(async () => {
    setPhase('waiting')
    setRoomList(null)
    try {
      await socketRef.current.addMatchmaker(MM_QUERY, 2, 2, MM_PROPS, {})
    } catch (e) {
      setError(e.message)
      setPhase('lobby')
    }
  }, [])

  const handleCreateRoom = useCallback(async () => {
    try {
      const resp = await clientRef.current.rpc(sessionRef.current, 'create_match', {})
      const { match_id } = JSON.parse(resp.payload)
      // Set ref + state before await so handleMove is never stale
      matchIdRef.current = match_id
      setMatchId(match_id)
      sessionStorage.setItem('ttt_match_id', match_id)
      await socketRef.current.joinMatch(match_id)
      setPhase('waiting')
      setRoomList(null)
    } catch (e) {
      matchIdRef.current = null
      setMatchId(null)
      sessionStorage.removeItem('ttt_match_id')
      setError(e.message)
    }
  }, [])

  const handleBrowse = useCallback(async () => {
    try {
      const resp = await clientRef.current.rpc(sessionRef.current, 'list_matches', {})
      const { matches } = JSON.parse(resp.payload)
      setRoomList(matches)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const handleJoinRoom = useCallback(async (mid) => {
    try {
      // Set ref + state before await so handleMove is never stale
      matchIdRef.current = mid
      setMatchId(mid)
      sessionStorage.setItem('ttt_match_id', mid)
      await socketRef.current.joinMatch(mid)
      setPhase('waiting')
      setRoomList(null)
    } catch (e) {
      matchIdRef.current = null
      setMatchId(null)
      sessionStorage.removeItem('ttt_match_id')
      setError(e.message)
    }
  }, [])

  // ── In-game actions ────────────────────────────────────────────────────────

  const handleMove = useCallback((index) => {
    // Use matchIdRef (always current) rather than the matchId state closure,
    // which may lag by one render if the board appeared before setMatchId fired.
    const mid = matchIdRef.current
    if (!isMyTurn || !mid || gs?.board[index] !== null) return
    socketRef.current?.sendMatchState(
      mid, OP_STATE, JSON.stringify({ type: 'move', index })
    )
  }, [isMyTurn, gs])

  const handlePlayAgain = useCallback(() => {
    matchIdRef.current = null
    sessionStorage.removeItem('ttt_match_id')
    setMatchId(null)
    setGs(null)
    setPhase('lobby')
    setRoomList(null)
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="ttt">
        <p className="ttt-error">{error}</p>
        <button className="ttt-btn" onClick={() => { setError(null); location.reload() }}>
          Retry
        </button>
      </div>
    )
  }

  if (phase === 'connecting') {
    return <Spinner label="Connecting…" />
  }

  if (phase === 'lobby') {
    return (
      <Lobby
        roomList={roomList}
        onAutoMatch={handleAutoMatch}
        onCreateRoom={handleCreateRoom}
        onBrowse={handleBrowse}
        onJoinRoom={handleJoinRoom}
        onClearRooms={() => setRoomList(null)}
      />
    )
  }

  if (phase === 'waiting') {
    return (
      <Spinner
        label="Waiting for opponent…"
        sub={matchId ? 'Room code: ' + matchId.slice(0, 8).toUpperCase() : null}
        onCancel={handlePlayAgain}
      />
    )
  }

  // phase === 'playing' | 'finished'
  return (
    <GameBoard
      gs={gs}
      myMark={myMark}
      isMyTurn={isMyTurn}
      onMove={handleMove}
      onPlayAgain={phase === 'finished' ? handlePlayAgain : null}
    />
  )
}

// ── Sub-components — pure presentation, no Nakama imports ─────────────────────

function Spinner({ label, sub, onCancel }) {
  return (
    <div className="ttt">
      <div className="ttt-spinner" role="status" aria-label={label} />
      <p className="ttt-status">{label}</p>
      {sub    && <p className="ttt-sub">{sub}</p>}
      {onCancel && (
        <button className="ttt-btn ttt-btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  )
}

function Lobby({ roomList, onAutoMatch, onCreateRoom, onBrowse, onJoinRoom, onClearRooms }) {
  return (
    <div className="ttt">
      <h1 className="ttt-title">Tic-Tac-Toe</h1>
      <p className="ttt-sub">Real-time · Server-authoritative</p>

      <div className="ttt-lobby-actions">
        <button className="ttt-btn" onClick={onAutoMatch}>
          Auto Match
        </button>
        <button className="ttt-btn" onClick={onCreateRoom}>
          Create Room
        </button>
        <button
          className="ttt-btn ttt-btn-secondary"
          onClick={roomList !== null ? onClearRooms : onBrowse}
        >
          {roomList !== null ? 'Hide Rooms' : 'Browse Rooms'}
        </button>
      </div>

      {roomList !== null && (
        <div className="ttt-room-list">
          {roomList.length === 0 ? (
            <p className="ttt-sub">No open rooms found.</p>
          ) : (
            roomList.map((r) => (
              <button
                key={r.match_id}
                className="ttt-btn ttt-btn-secondary ttt-room-item"
                onClick={() => onJoinRoom(r.match_id)}
              >
                {'Room ' + r.match_id.slice(0, 8).toUpperCase() + ' · ' + r.players + '/2'}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function GameBoard({ gs, myMark, isMyTurn, onMove, onPlayAgain }) {
  // Show a brief syncing spinner until the first server state arrives
  if (!gs) return <Spinner label="Syncing game state…" />

  const { board, status, currentPlayer, winner, seats } = gs

  // Status text — sourced entirely from server state
  let statusText = ''
  if (status === 'waiting') {
    statusText = 'Waiting for opponent…'
  } else if (status === 'playing') {
    statusText = isMyTurn
      ? `Your turn (${myMark})`
      : `Opponent's turn (${currentPlayer})`
  } else if (status === 'finished') {
    if (winner === 'draw')       statusText = "It's a draw!"
    else if (winner === myMark)  statusText = 'You win! 🎉'
    else                         statusText = winner + ' wins'
  }

  const opponentMark = myMark === 'X' ? 'O' : 'X'

  return (
    <div className="ttt">
      {/* Player labels — rendered only after server assigns marks */}
      {myMark && (
        <div className="ttt-players">
          <span className={'ttt-player ' + (myMark === 'X' ? 'ttt-player-x' : '')}>
            You ({myMark})
          </span>
          <span className="ttt-player-vs">vs</span>
          <span className={'ttt-player ' + (opponentMark === 'X' ? 'ttt-player-x' : '')}>
            Opp ({opponentMark})
          </span>
        </div>
      )}

      <p className={'ttt-status' + (status === 'finished' ? ' ttt-status-end' : '')}>
        {statusText}
      </p>

      {/* Board — pointer-events disabled when not your turn or game over */}
      <div
        className="ttt-board"
        aria-label="Tic-tac-toe board"
        data-disabled={String(!isMyTurn || status !== 'playing')}
      >
        {board.map((mark, i) => (
          <button
            key={i}
            className="ttt-cell"
            data-mark={mark || undefined}
            disabled={!isMyTurn || status !== 'playing' || mark !== null}
            onClick={() => onMove(i)}
            aria-label={`Cell ${i + 1}${mark ? ', ' + mark : ''}`}
          >
            {mark}
          </button>
        ))}
      </div>

      {/* Play again — only shown after game ends */}
      {onPlayAgain && (
        <button className="ttt-btn" onClick={onPlayAgain}>
          Play Again
        </button>
      )}
    </div>
  )
}
