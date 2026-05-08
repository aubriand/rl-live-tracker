'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  /**
   * Subscribe to stats updates from the main process.
   * Returns an unsubscribe function.
   */
  onStatsUpdate: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('stats:update', handler)
    return () => ipcRenderer.removeListener('stats:update', handler)
  },
  /**
   * Subscribe to session history updates.
   * Returns an unsubscribe function.
   */
  onHistoryUpdate: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('history:update', handler)
    return () => ipcRenderer.removeListener('history:update', handler)
  },
  /** Returns the current session history snapshot. */
  getHistory: () => ipcRenderer.invoke('history:get'),
})
