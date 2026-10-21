const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("files", {
  initialFile: () => ipcRenderer.invoke("initial-file"),
  openDialog: () => ipcRenderer.invoke("open-pdf-dialog"),
  loadPdf: pdfPath => ipcRenderer.invoke("load-pdf", pdfPath),
  saveAnnotations: (pdfPath, data) => ipcRenderer.invoke("save-annotations", pdfPath, data),
  exportDialog: pdfPath => ipcRenderer.invoke("export-dialog", pdfPath),
  writeExport: (outPath, bytes, sidecar) => ipcRenderer.invoke("write-export", outPath, bytes, sidecar),
});
