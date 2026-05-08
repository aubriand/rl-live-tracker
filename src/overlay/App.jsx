import React, { useEffect } from 'react'
import useStatsStore from '../store'
import StatsDisplay from './components/StatsDisplay'

export default function App() {
  const setStats = useStatsStore((s) => s.setStats)

  useEffect(() => {
    if (!window.api) return
    // window.api.onStatsUpdate returns an unsubscribe fn
    const unsub = window.api.onStatsUpdate((data) => {
      setStats(data)
    })
    return unsub
  }, [setStats])

  return <StatsDisplay />
}
