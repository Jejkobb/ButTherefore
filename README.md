# ButTherefore

Chromium-based Story Beat Node Editor (Electron + React + TypeScript).

## MVP Features
- Infinite dark canvas with React Flow.
- Custom story beat nodes:
  - Editable title.
  - Editable beat lines.
  - Image attachments via drag/drop or file picker.
- Custom curved edges with midpoint relation toggle (`BUT` / `THEREFORE`).
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
