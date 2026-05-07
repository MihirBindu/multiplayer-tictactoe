/**
 * TicTacToe.jsx — self-contained multiplayer UI
 *
 * Responsibilities:
 *   • Nakama session + WebSocket lifecycle (single useEffect)
 *   • Lobby: auto-matchmaker | create room | browse rooms (auto-refreshed)
 *   • Game board: disabled when not your turn or game over
 *   • Player labels + match status sourced from server state only
 *   • Reconnect: rejoin saved match on reload; fall back to lobby on failure
 *   • Deep-link: ?room=MATCH_ID auto-joins on load + copy-link button
 *   • Keyboard: numpad 1–9 for moves (7=top-left … 3=bottom-right)
 *   • Accessibility: aria-live on status, row/col cell labels, focus-traversable board
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Client } from '@heroiclabs/nakama-js'
import './tictactoe.css'

// ── Nakama connection constants ────────────────────────────────────────────────
const IS_DEV  = import.meta.env.DEV
const NK_HOST = IS_DEV ? 'localhost'                         : window.location.hostname
const NK_PORT = IS_DEV ? '7350'                              : (window.location.port || '80')
const NK_SSL  = !IS_DEV && window.location.protocol === 'https:'
const NK_KEY  = import.meta.env.VITE_NK_KEY || 'defaultkey'

const OP_STATE = 1
const MM_QUERY = '+properties.game_mode:classic'
const MM_PROPS = { game_mode: 'classic' }

// All 8 winning triplets for client-side winning-cell detection (purely visual)
const WINNING_LINES = [
  [0,1,2],[3,4,5],[6,7,8],   // rows
  [0,3,6],[1,4,7],[2,5,8],   // cols
  [0,4,8],[2,4,6],           // diagonals
]

// Numpad layout: key '7' → cell 0 (top-left) … key '3' → cell 8 (bottom-right)
const KEY_TO_CELL = { '7':0,'8':1,'9':2,'4':3,'5':4,'6':5,'1':6,'2':7,'3':8 }

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function getDeviceId() {
  const key = 'ttt_device_id'
  let id = sessionStorage.getItem(key)
  if (!id) { id = generateUUID(); sessionStorage.setItem(key, id) }
  return id
}

function decodeState(u8) {
  try { return JSON.parse(new TextDecoder().decode(u8)) } catch { return null }
}

/** Re-derive which cells form the winning line for visual highlighting. */
function getWinningCells(board, winner) {
  if (!winner || winner === 'draw') return null
  for (const line of WINNING_LINES) {
    if (line.every(i => board[i] === winner)) return new Set(line)
  }
  return null
}

/** Map raw Nakama/WebSocket error messages to user-friendly copy. */
function mapError(msg) {
  if (!msg) return 'Something went wrong. Please try again.'
  const m = msg.toLowerCase()
  if (m.includes('websocket') || m.includes('failed to connect') || m.includes('connection refused')) {
    return "Couldn't reach the game server. Check your connection."
  }
  if (m.includes('full'))  return 'This room is full. Try another.'
  if (m.includes('not found') || m.includes('ended') || m.includes('closed')) {
    return 'This game has ended or no longer exists.'
  }
  if (m.includes('timeout')) return 'Connection timed out. Check your internet and try again.'
  if (m.includes('unauthorized') || m.includes('401')) return 'Session expired. Please reload.'
  return "Couldn't connect to the game server. Please try again."
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TicTacToe() {
  // phase: connecting → lobby → waiting → playing → finished
  const [phase,        setPhase]        = useState('connecting')
  const [gs,           setGs]           = useState(null)
  const [userId,       setUserId]       = useState(null)
  const [matchId,      setMatchId]      = useState(null)
  const [roomList,     setRoomList]     = useState(null)   // null = not browsing
  const [lastRefreshed, setLastRefreshed] = useState(null)
  const [error,        setError]        = useState(null)
  const [socketStatus, setSocketStatus] = useState('connecting')

  const clientRef  = useRef(null)
  const socketRef  = useRef(null)
  const sessionRef = useRef(null)
  // matchIdRef mirrors matchId state but is always current — avoids stale-closure
  // races where the board renders before setMatchId fires.
  const matchIdRef = useRef(null)

  const myMark   = gs?.seats?.X === userId ? 'X'
                 : gs?.seats?.O === userId ? 'O'
                 : null
  const isMyTurn = phase === 'playing' && gs?.currentPlayer === myMark

  // ── Dynamic document title ─────────────────────────────────────────────────
  useEffect(() => {
    const suffix = ' · Tic-Tac-Toe'
    if (phase === 'connecting' || phase === 'lobby') {
      document.title = 'Tic-Tac-Toe'
    } else if (phase === 'waiting') {
      document.title = 'Waiting for opponent' + suffix
    } else if (phase === 'playing') {
      document.title = (isMyTurn ? 'Your turn' : "Opponent's turn") + suffix
    } else if (phase === 'finished') {
      const { winner } = gs ?? {}
      if (winner === 'draw')      document.title = "It's a draw!" + suffix
      else if (winner === myMark) document.title = 'You won!' + suffix
      else                        document.title = 'Game over' + suffix
    }
  }, [phase, isMyTurn, gs, myMark])

  // ── Prevent pull-to-refresh during an active game ─────────────────────────
  useEffect(() => {
    if (phase !== 'playing') return
    document.body.style.setProperty('overscroll-behavior-y', 'contain')
    return () => document.body.style.removeProperty('overscroll-behavior-y')
  }, [phase])

  // ── Connect to Nakama (once on mount) ─────────────────────────────────────
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

        sock.ondisconnect = () => {
          if (alive) setSocketStatus('offline')
        }

        // ── Server → client: full state broadcast ──────────────────────────
        sock.onmatchdata = (d) => {
          if (d.op_code !== OP_STATE || !alive) return
          const state = decodeState(d.data)
          if (!state) return
          setGs(state)
          if (state.status === 'playing')  setPhase('playing')
          if (state.status === 'finished') setPhase('finished')
        }

        // ── Matchmaker paired → join created match ─────────────────────────
        sock.onmatchmakermatched = async (matched) => {
          if (!alive) return
          const mid = matched.match_id
          if (!mid) return
          matchIdRef.current = mid
          setMatchId(mid)
          sessionStorage.setItem('ttt_match_id', mid)
          try {
            await sock.joinMatch(mid)
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
        setSocketStatus('connected')

        // ── Deep-link: ?room=MATCH_ID → auto-join ─────────────────────────
        const roomParam = new URLSearchParams(window.location.search).get('room')
        if (roomParam) {
          history.replaceState(null, '', window.location.pathname)
          matchIdRef.current = roomParam
          setMatchId(roomParam)
          sessionStorage.setItem('ttt_match_id', roomParam)
          try {
            await sock.joinMatch(roomParam)
            if (!alive) return
            setPhase('waiting')
          } catch {
            matchIdRef.current = null
            setMatchId(null)
            sessionStorage.removeItem('ttt_match_id')
            if (alive) setPhase('lobby')
          }
          return
        }

        // ── Reconnect: rejoin previously saved match ───────────────────────
        const saved = sessionStorage.getItem('ttt_match_id')
        if (saved) {
          matchIdRef.current = saved
          setMatchId(saved)
          try {
            await sock.joinMatch(saved)
            if (!alive) return
            setPhase('waiting')   // server broadcasts 'playing' if match is live
          } catch {
            matchIdRef.current = null
            setMatchId(null)
            sessionStorage.removeItem('ttt_match_id')
            if (alive) setPhase('lobby')
          }
        } else {
          if (alive) setPhase('lobby')
        }
      } catch (e) {
        if (alive) {
          setSocketStatus('offline')
          setError(String(e?.message ?? e))
        }
      }
    }

    init()
    return () => {
      alive = false
      socketRef.current?.disconnect(false)
    }
  }, [])

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
      const resp = await clientRef.current.rpc(sessionRef.current, 'create_match', '{}')
      const data = typeof resp.payload === 'string' ? JSON.parse(resp.payload) : resp.payload
      const { match_id } = data
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
      const resp = await clientRef.current.rpc(sessionRef.current, 'list_matches', '{}')
      const data = typeof resp.payload === 'string' ? JSON.parse(resp.payload) : resp.payload
      const { matches } = data
      setRoomList(matches)
      setLastRefreshed(Date.now())
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const handleJoinRoom = useCallback(async (mid) => {
    try {
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

  // Uses matchIdRef (always current) rather than matchId state to avoid
  // stale-closure races when the board renders before setMatchId fires.
  const handleMove = useCallback((index) => {
    const mid = matchIdRef.current
    if (!isMyTurn || !mid || gs?.board[index] !== null) return
    socketRef.current?.sendMatchState(
      mid, OP_STATE, JSON.stringify({ type: 'move', index })
    )
  }, [isMyTurn, gs])

  // ── Keyboard shortcuts: numpad 1–9 for moves ───────────────────────────────
  // Placed after handleMove so the const is initialized before it's referenced.
  useEffect(() => {
    if (phase !== 'playing' || !isMyTurn) return
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const idx = KEY_TO_CELL[e.key]
      if (idx !== undefined) handleMove(idx)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [phase, isMyTurn, handleMove])

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
        <SocketStatusPill status={socketStatus} />
        <ErrorScreen
          rawError={error}
          onRetry={() => { setError(null); location.reload() }}
          onBack={() => { setError(null); setPhase('lobby') }}
        />
      </div>
    )
  }

  if (phase === 'connecting') {
    return (
      <div className="ttt">
        <h1 className="ttt-title">Tic-Tac-Toe</h1>
        <p className="ttt-sub">Real-time · Server-authoritative</p>
        <div className="ttt-spinner" role="status" aria-label="Connecting to game server" />
        <p className="ttt-status" aria-live="polite">Connecting…</p>
      </div>
    )
  }

  if (phase === 'lobby') {
    return (
      <>
        <SocketStatusPill status={socketStatus} />
        <Lobby
          roomList={roomList}
          onAutoMatch={handleAutoMatch}
          onCreateRoom={handleCreateRoom}
          onBrowse={handleBrowse}
          onJoinRoom={handleJoinRoom}
          onClearRooms={() => setRoomList(null)}
        />
      </>
    )
  }

  if (phase === 'waiting') {
    return (
      <div className="ttt">
        <SocketStatusPill status={socketStatus} />
        <div className="ttt-spinner" role="status" aria-label="Waiting for opponent" />
        <p className="ttt-status" aria-live="polite">Waiting for opponent…</p>
        {matchId && <RoomCodeCard matchId={matchId} />}
        <button
          className="ttt-btn ttt-btn-secondary"
          style={{ width: 'min(90vw, 200px)' }}
          onClick={handlePlayAgain}
        >
          Cancel
        </button>
      </div>
    )
  }

  // phase === 'playing' | 'finished'
  return (
    <>
      <SocketStatusPill status={socketStatus} />
      <GameBoard
        gs={gs}
        myMark={myMark}
        isMyTurn={isMyTurn}
        onMove={handleMove}
        onPlayAgain={phase === 'finished' ? handlePlayAgain : null}
      />
    </>
  )
}

// ── Sub-components — pure presentation, no Nakama imports ─────────────────────

/** Shows only when offline — hidden when connected (avoids visual noise). */
function SocketStatusPill({ status }) {
  if (status !== 'offline') return null
  return (
    <div className="ttt-socket-status ttt-socket-status--offline" aria-live="polite">
      <span className="ttt-socket-dot" />
      Offline
    </div>
  )
}

function ErrorScreen({ rawError, onRetry, onBack }) {
  const [showDetail, setShowDetail] = useState(false)
  const friendlyMsg = mapError(rawError)
  return (
    <div className="ttt-error-box">
      <p className="ttt-error">⚠ {friendlyMsg}</p>
      <div className="ttt-error-actions">
        <button
          className="ttt-btn ttt-btn-secondary"
          style={{ width: 'auto' }}
          onClick={onBack}
        >
          Back to lobby
        </button>
        <button
          className="ttt-btn"
          style={{ width: 'auto' }}
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
      <button
        className="ttt-error-toggle"
        onClick={() => setShowDetail(v => !v)}
      >
        {showDetail ? 'Hide' : 'Show'} technical details
      </button>
      {showDetail && <p className="ttt-error-detail">{rawError}</p>}
    </div>
  )
}

function RoomCodeCard({ matchId }) {
  const [copied, setCopied] = useState(false)
  // Display only the first 8 chars uppercase — full ID is in the share URL
  const shortCode = matchId.slice(0, 8).toUpperCase()
  const roomUrl   = `${window.location.origin}${window.location.pathname}?room=${matchId}`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl)
    } catch {
      try { await navigator.clipboard.writeText(matchId) } catch { return }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleShare = () =>
    navigator.share?.({ title: 'Join my Tic-Tac-Toe game', url: roomUrl }).catch(() => {})

  return (
    <div className="ttt-room-card">
      <span className="ttt-room-card-label">Share with a friend</span>
      <span className="ttt-room-code">{shortCode}</span>
      <div className="ttt-room-actions">
        <button
          className={`ttt-copy-btn${copied ? ' ttt-copy-btn--copied' : ''}`}
          onClick={handleCopy}
        >
          {copied ? '✓ Copied!' : '📋 Copy link'}
        </button>
        {typeof navigator.share === 'function' && (
          <button className="ttt-copy-btn" onClick={handleShare}>
            ↗ Share
          </button>
        )}
      </div>
    </div>
  )
}

function Lobby({ roomList, onAutoMatch, onCreateRoom, onBrowse, onJoinRoom, onClearRooms }) {
  const isBrowsing = roomList !== null

  // Auto-refresh room list every 3 s while the list is open
  useEffect(() => {
    if (!isBrowsing) return
    const id = setInterval(onBrowse, 3000)
    return () => clearInterval(id)
  }, [isBrowsing, onBrowse])

  return (
    <div className="ttt">
      <h1 className="ttt-title">Tic-Tac-Toe</h1>
      <p className="ttt-sub">Real-time · Server-authoritative</p>

      <div className="ttt-lobby-actions">
        {/* Primary — zero-decision path for newcomers */}
        <div className="ttt-lobby-action">
          <button className="ttt-btn ttt-btn-primary" onClick={onAutoMatch}>
            Auto Match
          </button>
          <span className="ttt-lobby-caption">Get paired instantly</span>
        </div>

        {/* Secondary — create a private room for a friend */}
        <div className="ttt-lobby-action">
          <button className="ttt-btn ttt-btn-secondary" onClick={onCreateRoom}>
            Create Room
          </button>
          <span className="ttt-lobby-caption">Get a code to share with a friend</span>
        </div>

        {/* Ghost / tertiary — browse open games */}
        <div className="ttt-lobby-action">
          <button
            className="ttt-btn ttt-btn-ghost"
            onClick={isBrowsing ? onClearRooms : onBrowse}
          >
            {isBrowsing ? 'Hide Rooms' : 'Browse Rooms'}
          </button>
          <span className="ttt-lobby-caption">Join an open game</span>
        </div>
      </div>

      {isBrowsing && (
        <>
          <div className="ttt-room-list-header">
            <span className="ttt-room-list-meta">Open rooms</span>
            <span className="ttt-room-list-meta">
              <span className="ttt-live-dot" aria-hidden="true" />
              Live
            </span>
          </div>

          <div className="ttt-room-list">
            {roomList.length === 0 ? (
              <div className="ttt-empty-state">
                <span className="ttt-empty-state-icon" aria-hidden="true">🎮</span>
                <p>No open rooms yet. Be the first!</p>
                <button
                  className="ttt-btn ttt-btn-secondary"
                  style={{ width: 'auto', padding: '0.5rem 1.25rem' }}
                  onClick={onCreateRoom}
                >
                  Create a Room
                </button>
              </div>
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
        </>
      )}
    </div>
  )
}

function GameBoard({ gs, myMark, isMyTurn, onMove, onPlayAgain }) {
  if (!gs) {
    return (
      <div className="ttt">
        <div className="ttt-spinner" role="status" aria-label="Syncing game state" />
        <p className="ttt-status">Syncing game state…</p>
      </div>
    )
  }

  const { board, status, currentPlayer, winner } = gs
  const isDisabled  = !isMyTurn || status !== 'playing'
  const winningCells = status === 'finished' ? getWinningCells(board, winner) : null
  const opponentMark = myMark === 'X' ? 'O' : 'X'

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

  return (
    <div className="ttt">
      {/* Player chips — mark color is independent of "you" indicator */}
      {myMark && (
        <div className="ttt-players">
          <span className={`ttt-player ttt-player--mark-${myMark.toLowerCase()} ttt-player--me`}>
            You ({myMark})
          </span>
          <span className="ttt-player-vs">vs</span>
          <span className={`ttt-player ttt-player--mark-${opponentMark.toLowerCase()}`}>
            Opp ({opponentMark})
          </span>
        </div>
      )}

      {/* Status — aria-live so screen readers announce turn changes and results */}
      <p
        className={'ttt-status' + (status === 'finished' ? ' ttt-status-end' : '')}
        aria-live={status === 'finished' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {statusText}
      </p>

      {/* Board — pointer-events NOT disabled; native `disabled` on each button
          is sufficient to block clicks while keeping cells keyboard-focusable. */}
      <div
        className="ttt-board"
        aria-label="Tic-tac-toe board"
        data-disabled={String(isDisabled)}
      >
        {board.map((mark, i) => {
          const row = Math.floor(i / 3) + 1
          const col = (i % 3) + 1
          return (
            <button
              key={i}
              className={`ttt-cell${winningCells?.has(i) ? ' ttt-cell--winner' : ''}`}
              data-mark={mark || undefined}
              disabled={isDisabled || mark !== null}
              onClick={() => onMove(i)}
              aria-label={`Row ${row}, column ${col}${mark ? ', ' + mark : ', empty'}`}
            >
              {mark}
            </button>
          )
        })}
      </div>

      {/* Keyboard shortcut hint — hidden from screen readers (decorative) */}
      {status === 'playing' && isMyTurn && (
        <p className="ttt-kbd-hint" aria-hidden="true">
          Use <kbd className="ttt-kbd">7</kbd>–<kbd className="ttt-kbd">9</kbd>
          &nbsp;/&nbsp;
          <kbd className="ttt-kbd">4</kbd>–<kbd className="ttt-kbd">6</kbd>
          &nbsp;/&nbsp;
          <kbd className="ttt-kbd">1</kbd>–<kbd className="ttt-kbd">3</kbd>
          &nbsp;to move
        </p>
      )}

      {onPlayAgain && (
        <button
          className="ttt-btn"
          style={{ width: 'min(90vw, 200px)' }}
          onClick={onPlayAgain}
        >
          Play Again
        </button>
      )}
    </div>
  )
}
