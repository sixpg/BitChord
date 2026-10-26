'use strict';

const { app, BrowserWindow, session, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const APP_PORT = 5173;
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
let staticServer;

function getResourcePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, 'resources', name);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm'
};

function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const absoluteRoot = path.resolve(root);
    const indexFile = path.join(absoluteRoot, 'index.html');
    if (!fs.existsSync(indexFile)) {
      reject(new Error(`BitChord web build is missing: ${indexFile}`));
      return;
    }

    staticServer = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url || '/', APP_ORIGIN).pathname);
      } catch {
        res.writeHead(400).end('Bad request');
        return;
      }

      // Resolve requested files inside the bundled web root only.
      const requested = path.resolve(absoluteRoot, `.${pathname}`);
      if (requested !== absoluteRoot && !requested.startsWith(absoluteRoot + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      let file = requested;
      try {
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
          file = path.join(file, 'index.html');
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          // React Router routes should serve the SPA entry point.
          file = indexFile;
        }
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600'
        });
        res.end(body);
      } catch (error) {
        console.error('Local web server error:', error);
        res.writeHead(500).end('Unable to load BitChord');
      }
    });

    // Keep the server loopback-only; the bundled Chromium extension is built
    // specifically for this local origin.
    staticServer.once('error', reject);
    staticServer.listen(APP_PORT, '127.0.0.1', () => resolve());
  });
}

async function createWindow() {
  const webRoot = getResourcePath('web');
  const extensionRoot = getResourcePath('extension');

  await startStaticServer(webRoot);

  // The web client relies on the companion Chromium extension for specific
  // authenticated playback and request-header operations. Electron supports
  // Chromium extension APIs only partially, so this is best-effort.
  if (fs.existsSync(path.join(extensionRoot, 'manifest.json'))) {
    try {
      await session.defaultSession.loadExtension(extensionRoot, { allowFileAccess: false });
      console.log('BitChord companion extension loaded.');
    } catch (error) {
      console.warn('Could not load BitChord companion extension:', error);
      dialog.showMessageBox({
        type: 'warning',
        title: 'BitChord extension warning',
        message: 'The BitChord desktop window opened, but its companion extension could not be loaded.',
        detail: 'Some playback, sign-in, or request-handling features may not work in this build.'
      });
    }
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'BitChord',
    backgroundColor: '#0d0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_ORIGIN && !url.startsWith(`${APP_ORIGIN}/`)) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    }
  });

  await win.loadURL(APP_ORIGIN);
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    console.error(error);
    dialog.showErrorBox(
      'BitChord could not start',
      `${error.message}\n\nClose other apps that may be using port ${APP_PORT}, then try again.`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
  });
});

app.on('window-all-closed', () => {
  if (staticServer) staticServer.close();
  if (process.platform !== 'darwin') app.quit();
});
