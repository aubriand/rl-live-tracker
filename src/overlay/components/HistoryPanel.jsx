import React, { useState } from 'react'

// ─── SVG Line Chart for MMR ───────────────────────────────────────────────────
function MmrChart({ history }) {
  const [tooltip, setTooltip] = useState(null)
  const points = history.filter((h) => h.mmr > 0)

  if (points.length < 2) {
    return (
      <p className="h-chart-empty">
        {points.length === 0
          ? 'Aucun MMR récupéré pour cette session'
          : 'Au moins 2 matchs avec MMR nécessaires pour afficher le graphique'}
      </p>
    )
  }

  const W = 600
  const H = 160
  const PAD = { top: 14, right: 20, bottom: 28, left: 52 }
  const iW = W - PAD.left - PAD.right
  const iH = H - PAD.top - PAD.bottom

  const mmrs = points.map((p) => p.mmr)
  const minM = Math.min(...mmrs)
  const maxM = Math.max(...mmrs)
  const spread = maxM - minM || 30
  const yMin = minM - spread * 0.2
  const yMax = maxM + spread * 0.2

  // Spread points evenly across the total number of matches (preserves gaps)
  const total = history.length
  const xOf = (matchId) =>
    PAD.left + ((matchId - 1) / Math.max(1, total - 1)) * iW
  const yOf = (mmr) =>
    PAD.top + (1 - (mmr - yMin) / (yMax - yMin)) * iH

  const polyPts = points.map((p) => `${xOf(p.id)},${yOf(p.mmr)}`).join(' ')

  // Y axis ticks (4 steps)
  const tickCount = 4
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) =>
    Math.round(yMin + (i / tickCount) * (yMax - yMin))
  )

  // X axis labels: show every Nth match to avoid overlap
  const xStep = Math.max(1, Math.ceil(total / 7))

  const handleMouseMove = (e) => {
      const svgRect = e.currentTarget.getBoundingClientRect()
      // Scale CSS pixels → SVG viewBox units
      const scaleX = W / svgRect.width
      const mx = (e.clientX - svgRect.left) * scaleX

      // Find nearest point
      let nearest = null
      let nearestDist = Infinity
      points.forEach((p) => {
        const px = xOf(p.id)
        const dist = Math.abs(px - mx)
        if (dist < nearestDist) {
          nearestDist = dist
          nearest = p
        }
      })

      if (nearest && nearestDist < 40) {
        const px = xOf(nearest.id)
        const py = yOf(nearest.mmr)
        setTooltip({ x: px, y: py, match: nearest })
      } else {
        setTooltip(null)
      }
    }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Grid + Y axis */}
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              y1={yOf(tick)}
              x2={PAD.left + iW}
              y2={yOf(tick)}
              stroke="#1f2937"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={yOf(tick) + 4}
              textAnchor="end"
              fontSize={10}
              fill="#4b5563"
            >
              {tick}
            </text>
          </g>
        ))}

        {/* X axis labels */}
        {history.map((h, i) =>
          i % xStep === 0 || i === history.length - 1 ? (
            <text
              key={h.id}
              x={xOf(h.id)}
              y={H - 6}
              textAnchor="middle"
              fontSize={10}
              fill="#4b5563"
            >
              M{h.id}
            </text>
          ) : null
        )}

        {/* MMR line */}
        <polyline
          fill="none"
          stroke="#3b82f6"
          strokeWidth={2}
          strokeLinejoin="round"
          points={polyPts}
        />

        {/* Win/loss colored dots */}
        {points.map((p) => (
          <circle
            key={p.id}
            cx={xOf(p.id)}
            cy={yOf(p.mmr)}
            r={5}
            fill={p.result === 'win' ? '#4ade80' : '#f87171'}
            stroke={p.result === 'win' ? '#166534' : '#991b1b'}
            strokeWidth={1.5}
          />
        ))}

        {/* Hover crosshair */}
        {tooltip && (
          <line
            x1={tooltip.x}
            y1={PAD.top}
            x2={tooltip.x}
            y2={PAD.top + iH}
            stroke="#374151"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
      </svg>

      {/* Tooltip bubble */}
      {tooltip && (
        <div
          className="h-chart-tooltip"
          style={{
            left: `${(tooltip.x / W) * 100}%`,
            top: `${(tooltip.y / H) * 100}%`,
          }}
        >
          <span className={`h-tt-result ${tooltip.match.result}`}>
            {tooltip.match.result === 'win' ? 'Victoire' : 'Défaite'}
          </span>
          <span className="h-tt-mmr">{tooltip.match.mmr} MMR</span>
          <span className="h-tt-meta">Match {tooltip.match.id}</span>
        </div>
      )}
    </div>
  )
}

// ─── Win/Loss bar timeline ────────────────────────────────────────────────────
function WinLossTimeline({ history }) {
  if (history.length === 0) return null
  return (
    <div className="h-timeline">
      {history.map((h) => (
        <div
          key={h.id}
          className={`h-tl-bar ${h.result}`}
          title={`M${h.id} — ${h.result === 'win' ? 'Victoire' : 'Défaite'}`}
        />
      ))}
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export default React.memo(function HistoryPanel({ history }) {
  const wins = history.filter((h) => h.result === 'win').length
  const losses = history.filter((h) => h.result === 'loss').length
  const total = wins + losses
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0

  const mmrPoints = history.filter((h) => h.mmr > 0)
  const startMmr = mmrPoints[0]?.mmr ?? 0
  const currentMmr = mmrPoints[mmrPoints.length - 1]?.mmr ?? 0
  const mmrDelta = mmrPoints.length >= 2 ? currentMmr - startMmr : null

  return (
    <div className="h-panel">
      {/* Header */}
      <div className="h-header">
        <h1 className="h-title">Historique de session</h1>
        <div className="h-badges">
          <span className="h-badge win">{wins}V</span>
          <span className="h-badge loss">{losses}D</span>
          <span className="h-badge neutral">{winRate}%</span>
          {mmrDelta !== null && (
            <span className={`h-badge ${mmrDelta >= 0 ? 'win' : 'loss'}`}>
              {mmrDelta >= 0 ? '+' : ''}
              {mmrDelta} MMR
            </span>
          )}
          {currentMmr > 0 && (
            <span className="h-badge mmr">{currentMmr} MMR actuel</span>
          )}
        </div>
      </div>

      {/* W/L bar timeline */}
      {history.length > 0 && <WinLossTimeline history={history} />}

      {/* MMR chart */}
      {mmrPoints.length > 0 && (
        <div className="h-card">
          <h2 className="h-section-title">Progression MMR</h2>
          <MmrChart history={history} />
        </div>
      )}

      {/* Match list */}
      <div className="h-card">
        <h2 className="h-section-title">Matchs ({total})</h2>
        <div className="h-match-list">
          {history.length === 0 ? (
            <p className="h-empty">
              Aucun match enregistré — jouez une partie pour commencer
            </p>
          ) : (
            [...history].reverse().map((match) => {
              const time = new Date(match.timestamp).toLocaleTimeString('fr-FR', {
                hour: '2-digit',
                minute: '2-digit',
              })
              const streakText =
                match.streak > 0 ? `+${match.streak}` : String(match.streak)
              return (
                <div key={match.id} className={`h-match ${match.result}`}>
                  <div className={`h-dot ${match.result}`} />
                  <span className={`h-result-label ${match.result}`}>
                    {match.result === 'win' ? 'V' : 'D'}
                  </span>
                  <span className="h-time">{time}</span>
                  <span className="h-record">
                    {match.wins}V–{match.losses}D
                  </span>
                  {match.mmr > 0 && (
                    <span className="h-mmr">{match.mmr} MMR</span>
                  )}
                  <span
                    className={`h-streak ${
                      match.streak > 0 ? 'pos' : match.streak < 0 ? 'neg' : ''
                    }`}
                  >
                    {streakText}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
})
