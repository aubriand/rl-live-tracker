import React from 'react'
import useStatsStore from '../../store'

const StatsDisplay = React.memo(function StatsDisplay() {
  const wins = useStatsStore((s) => s.wins)
  const losses = useStatsStore((s) => s.losses)
  const streak = useStatsStore((s) => s.streak)
  const mmr = useStatsStore((s) => s.mmr)

  const streakClass =
    streak > 0 ? 'value streak-pos' : streak < 0 ? 'value streak-neg' : 'value'
  const streakText = streak > 0 ? `+${streak}` : String(streak)

  return (
    <div className="overlay">
      <div className="stat">
        <span className="label">W</span>
        <span className="value wins">{wins}</span>
      </div>
      <div className="stat">
        <span className="label">L</span>
        <span className="value losses">{losses}</span>
      </div>
      <div className="stat">
        <span className="label">Streak</span>
        <span className={streakClass}>{streakText}</span>
      </div>
      {mmr > 0 && (
        <div className="stat">
          <span className="label">MMR</span>
          <span className="value">{mmr}</span>
        </div>
      )}
    </div>
  )
})

export default StatsDisplay
