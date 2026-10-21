// Electron main process: window, app:// protocol for the bundled viewer, and file access for the renderer.
const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const configPath = () => path.join(app.getPath("userData"), "config.json");
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch { return {}; }
}
function writeConfig(patch) {
  fs.writeFileSync(configPath(), JSON.stringify({ ...readConfig(), ...patch }, null, 2));
}

// Annotations live next to the PDF: "paper.pdf" -> "paper.refs.json".
const sidecarPath = pdfPath => pdfPath.replace(/\.pdf$/i, "") + ".refs.json";

function initialFile() {
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find(a => /\.pdf$/i.test(a));
  if (arg && fs.existsSync(arg)) return path.resolve(arg);
  const last = readConfig().lastFile;
  return last && fs.existsSync(last) ? last : null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1300, height: 950,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.control && input.shift && input.key.toLowerCase() === "i") {
      win.webContents.toggleDevTools();
    }
  });
  win.loadURL("app://bundle/renderer/index.html");
}

app.whenReady().then(() => {
  // Serve only files inside the app directory.
  protocol.handle("app", req => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(__dirname, rel));
    if (!file.startsWith(__dirname + path.sep)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle("initial-file", () => initialFile());

  ipcMain.handle("open-pdf-dialog", async e => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: readConfig().lastDir, filters: [{ name: "PDF", extensions: ["pdf"] }], properties: ["openFile"],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle("load-pdf", (e, pdfPath) => {
    writeConfig({ lastFile: pdfPath, lastDir: path.dirname(pdfPath) });
    const sc = sidecarPath(pdfPath);
    return {
      bytes: fs.readFileSync(pdfPath),
      annotations: fs.existsSync(sc) ? JSON.parse(fs.readFileSync(sc, "utf8")) : null,
    };
  });

  ipcMain.handle("save-annotations", (e, pdfPath, data) => {
    const sc = sidecarPath(pdfPath);
    fs.writeFileSync(sc + ".tmp", JSON.stringify(data, null, 1));
    fs.renameSync(sc + ".tmp", sc);
  });

  ipcMain.handle("export-dialog", async (e, pdfPath) => {
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: pdfPath.replace(/\.pdf$/i, "") + " (refs).pdf", filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    return canceled ? null : filePath;
  });

  // Writes the exported PDF plus a viewer.html-compatible sidecar ("<name>.json" with definition notes).
  ipcMain.handle("write-export", (e, outPath, bytes, sidecar) => {
    fs.writeFileSync(outPath, Buffer.from(bytes));
    fs.writeFileSync(outPath.replace(/\.pdf$/i, "") + ".json", JSON.stringify(sidecar, null, 1));
  });

  createWindow();
});

app.on("window-all-closed", () => app.quit());
