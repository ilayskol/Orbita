'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('orbitaSettings',Object.freeze({
  load:()=>ipcRenderer.invoke('orbita-settings:load'),
  save:config=>ipcRenderer.invoke('orbita-settings:save',config),
}));
contextBridge.exposeInMainWorld('orbitaHistory',Object.freeze({
  list:()=>ipcRenderer.invoke('orbita-history:list'),
  save:payload=>ipcRenderer.invoke('orbita-history:save',payload),
  load:id=>ipcRenderer.invoke('orbita-history:load',id),
  remove:id=>ipcRenderer.invoke('orbita-history:remove',id),
  openFolder:id=>ipcRenderer.invoke('orbita-history:openFolder',id),
}));
