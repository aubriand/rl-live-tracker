import { create } from 'zustand'

const useStatsStore = create((set) => ({
  wins: 0,
  losses: 0,
  streak: 0,
  mmr: 0,
  setStats: (stats) => set(stats),
}))

export default useStatsStore
