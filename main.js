const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// foo.mp3 -> foo-edit.wav; foo-edit.wav stays foo-edit.wav so re-saving overwrites the edit, never the original.
function editPathFor(sourcePath) {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const name = base.endsWith('-edit') ? base : `${base}-edit`;
  return path.join(dir, `${name}.wav`);
}

ipcMain.handle('save-edit', async (_event, sourcePath, data) => {
  const outPath = editPathFor(sourcePath);
  await fs.writeFile(outPath, Buffer.from(data));
  return outPath;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 760,
    minHeight: 420,
    backgroundColor: '#16181d',
    title: 'SFX Editor',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
