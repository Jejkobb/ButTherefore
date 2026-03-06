# ButTherefore

Chromium-based Story Beat Node Editor (Electron + React + TypeScript).

## MVP Features
- Infinite dark canvas with React Flow.
- Custom story beat nodes:
  - Editable title.
  - Editable beat lines.
  - Image attachments via drag/drop or file picker.
  - Node creation via toolbar button, `N`, or double-clicking the canvas.
- Custom curved edges with midpoint relation toggle (`BUT` / `THEREFORE`).
- Dragging a connection from an output and releasing on empty canvas auto-creates a connected node.
- Command-based undo/redo for:
  - Node and edge creation.
  - Node movement.
  - Text edits.
  - Image attachments.
  - Relation toggles.
- Secure Electron architecture (`contextIsolation: true`, `nodeIntegration: false`, preload bridge + IPC).
- File I/O through IPC: New, Open, Save, Save As + autosave in app data.

## Shortcuts
- `N`: New node at viewport center.
- `Delete` / `Backspace`: Delete selected nodes/edges.
- `Ctrl/Cmd + Z`: Undo.
- `Ctrl/Cmd + Shift + Z`: Redo.
- `Ctrl/Cmd + S`: Save.
- `Ctrl/Cmd + O`: Open.

## Project File Format
- Main file: `*.storybeat.json`.
- Assets folder: sibling directory named `<project-name>.assets/`.
- JSON references image files by `relativePath`; image bytes are stored only on disk in the assets folder.

## Development
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```

## Distribution (Installer for friends)
Build a Windows installer without publishing:

```bash
npm run dist:win
```

Artifacts are written to `release/` (for example `ButTherefore-Setup-0.1.0.exe`).

## Auto-update via GitHub Releases
This project is configured to check for updates on app launch (packaged builds only) and download updates automatically.

Release workflow:
1. Bump the version in `package.json` (for example `0.1.0` -> `0.1.1`).
2. Create a GitHub personal access token with repo permissions.
3. Set it in PowerShell:

```powershell
$env:GH_TOKEN="your_github_token_here"
```

4. Publish the release:

```bash
npm run release:win
```

This command builds and publishes a GitHub Release for `Jejkobb/ButTherefore`, including updater metadata (`latest.yml`).
When your friends launch the installed app, it will check GitHub for a newer version and prompt to restart after download.
