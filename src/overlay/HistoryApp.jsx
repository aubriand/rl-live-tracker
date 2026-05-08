import React, { useState, useEffect } from 'react'
import HistoryPanel from './components/HistoryPanel'

export default function HistoryApp() {
  const [history, setHistory] = useState([])

  useEffect(() => {
    document.body.style.overflow = 'auto'
    document.body.style.background = '#111827'
    document.body.style.userSelect = 'text'

    if (window.api?.getHistory) {
      window.api.getHistory().then(setHistory)
    }

    if (window.api?.onHistoryUpdate) {
      return window.api.onHistoryUpdate(setHistory)
    }
  }, [])

  return <HistoryPanel history={history} />
}
