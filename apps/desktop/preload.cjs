"use strict";
// The only bridge between the settings page and the main process. It exposes two
// narrow calls; the page gets no Node access and never receives the stored API key.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("king3dSettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  save: (values) => ipcRenderer.invoke("settings:save", values),
  chooseBlender: () => ipcRenderer.invoke("settings:chooseBlender"),
});
