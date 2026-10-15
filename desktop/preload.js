const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  request: message => ipcRenderer.invoke('desktop:request', message),
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  login: () => ipcRenderer.invoke('desktop:login'),
  checkSession: () => ipcRenderer.invoke('desktop:session'),
  getFilters: () => ipcRenderer.invoke('desktop:getFilters'),
  getFavorites: () => ipcRenderer.invoke('desktop:getFavorites'),
  setFavorite: (key, selected) => ipcRenderer.invoke('desktop:setFavorite', key, selected),
  saveFilters: filters => ipcRenderer.invoke('desktop:saveFilters', filters),
  exportFile: file => ipcRenderer.invoke('desktop:export', file),
  openData: () => ipcRenderer.invoke('desktop:openData'),
  openExternal: url => ipcRenderer.invoke('desktop:external', url)
});
