# CHRONOS AI — Heritage Intelligence

> Every voice holds a universe. Every moment deserves to be remembered.

CHRONOS AI is an offline-first, local browser archive for exploring oral-history recordings and personal heritage material. This version deliberately uses browser-native HTML, CSS, Canvas, and JavaScript so it runs without a package install, build step, remote service, or network connection.

**The bundled records are synthetic fiction.** Their people, places, source filenames, and transcript excerpts are illustrative and are not real archival evidence. No playable media is bundled.

## Run locally

From this directory, start Python's built-in static web server:

```powershell
py -m http.server 8000 --bind 127.0.0.1
```

Open <http://localhost:8000> in a modern browser. Stop the server with `Ctrl+C`. The server serves static files from this folder only; it is not an application backend and does not receive uploaded media. The app makes no network requests. Directly opening `index.html` may also work, but browser storage behavior for `file:` pages varies; the local static server is more reliable.

No Node.js, npm packages, external fonts, CDNs, remote APIs, or model downloads are required. If Python's launcher is unavailable, install Python or open `index.html` directly in a modern browser.

## Use

1. Select **Enter the archive** and search a word or phrase such as `brass key`, `radio`, or `jasmine`.
2. Open a result to inspect its source, match reason, language, and transcript timestamp. A demo source filename is a citation only; the fictional demo media itself is not included.
3. Use **Add recording** to create a record, edit metadata and transcript segments, then import a local audio file in the Audio Studio to play and seek it. Segment text is manual; no speech recognition is claimed.
4. Import a local video to preview it, seek to a frame, and capture a still in the browser. Add user-authored notes to the selected record. OCR and image recognition are not implemented.
5. Explore TimeGraph by dragging to rotate, scrolling or using the controls to zoom, and selecting a node. Connections indicate shared speaker, place, or topic metadata only; unknown dates are not inferred.
6. Export JSON, CSV, or SRT from **Open Heritage Export**.

## Architecture

- `index.html` — accessible single-page application shell and interface sections.
- `styles.css` — responsive visual system, motion, and reduced-motion behavior.
- `data.js` — clearly labelled fictional demo archive.
- `app.js` — local persistence, keyword search, source navigation, Canvas TimeGraph, browser media handling, validation, and exports.
- `tests.html` — in-browser regression checks for search, timestamps, metadata validation, and exports.

The TimeGraph is a custom 2D Canvas renderer with perspective projection, depth sorting, pointer rotation, zoom, and explicit metadata links. It is an interactive 3D-style graph, not a Three.js/WebGL scene. A lightweight Canvas renderer avoids requiring GPU frameworks or large dependencies on ordinary PCs.

## Privacy, storage, and limitations

- Record metadata and transcript edits are stored in this browser's `localStorage` on this device. Clearing browser data removes them. Browser storage can be restricted or unavailable, especially for `file:` URLs; the app displays save failures.
- Imported audio and video use temporary browser object URLs. Files are not uploaded and are not persisted by the app; reselect them in a later session. Keep the originals and export archive backups.
- Video preview and frame capture depend on browser codec support and local file playback permissions. Captured stills are shown in the page and are not automatically written to disk.
- Search is genuine case-insensitive keyword matching across transcript text and record metadata; it is not semantic or AI search. Results rank transcript matches above metadata matches.
- No local speech-recognition model, OCR model, or image-recognition model is bundled or activated. Automatic transcription and generated image descriptions require separately installed local integrations.
- This is a local single-user prototype, not a records-management system. Validate, back up, and preserve original source files separately.

## Run the regression checks

With the local server running, open <http://localhost:8000/tests.html>. The page runs browser-native assertions in a hidden application frame and reports each result.

## License

This project and its original source files are offered under the MIT License. See [`LICENSE`](./LICENSE).
