import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import HistoryApp from './HistoryApp'
import './App.css'

const isHistory = new URLSearchParams(window.location.search).get('view') === 'history'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isHistory ? <HistoryApp /> : <App />}
  </React.StrictMode>
)
