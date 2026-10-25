const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveEdit: (sourcePath, data) => ipcRenderer.invoke('save-edit', sourcePath, data),
});
