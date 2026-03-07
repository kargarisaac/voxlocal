# Voxlocal

A Chrome extension that reads web pages, PDFs, and tweets aloud using locally running TTS servers. No cloud APIs, no data leaves your machine.

## Why

Browser-based read-aloud tools either send your content to external servers or sound robotic. Voxlocal gives you natural-sounding speech from modern open-source TTS models running entirely on your own hardware. It works with articles, academic papers, Twitter/X threads, and any selected text.

## What it does

- **Articles** -- extracts clean article text from any webpage using Mozilla Readability, stripping ads, navbars, and sidebars
- **PDFs** -- extracts text from PDFs opened in Chrome (including arxiv papers) with page range selection
- **X/Twitter** -- detects tweet pages and reads post content
- **Selected text** -- highlight anything and read it aloud via right-click or keyboard shortcut
- **Two TTS backends** -- Kokoro-FastAPI (50+ voices, multi-language) or KittenTTS (lightweight, English, 8 voices)
- **Gapless playback** -- text is split into sentence-level chunks with the next chunk pre-fetched while the current one plays
- **Floating widget** -- a small on-page control appears during playback with play/pause/stop/skip
- **Keyboard shortcuts** -- `Alt+Shift+R` to read, `Alt+Shift+S` to stop
- **Fully offline** -- everything runs locally via Docker

## How it's built

### Architecture

```
                         Chrome Extension (MV3)
                         ______________________
                        |                      |
  Webpage ----------->  | content.js           |  Extracts text (Readability / Twitter / selection)
                        |   |                  |
                        |   v                  |
                        | background.js        |  Chunks text, calls TTS API, manages state
                        |   |                  |
                        |   v                  |
                        | offscreen.js         |  Plays audio (MV3 service workers can't play audio)
                        |______________________|
                              |
                    POST /v1/audio/speech
                              |
                    __________|__________
                   |                     |
             Kokoro-FastAPI        KittenTTS server
             localhost:8880        localhost:8881
             (Docker)              (Docker)
```

### Extension (Chrome MV3, vanilla JS)

The extension is built with plain JavaScript -- no React, no webpack, no build step. You load it as an unpacked extension directly from the source directory.

Chrome MV3 imposes several constraints that shaped the architecture:

- **Service workers can't play audio.** The background script (`background.js`) runs as a service worker, so all audio playback happens in an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) (`offscreen.js`). Messages are routed between background and offscreen using `chrome.runtime.sendMessage` with a `target` field to prevent broadcast collisions.

- **Content scripts run in page context.** Text extraction (`content.js`) uses Mozilla Readability on a cloned DOM (Readability destructively modifies the document). For PDFs, the content script detects the page type and hands off to the background, which fetches the PDF and sends it to the offscreen document where PDF.js runs.

- **No ES module imports in service workers.** Background dependencies (`constants.js`, `utils/textProcessor.js`) are loaded via `importScripts()`.

### Text pipeline

1. **Extraction** -- content script extracts text based on page type (Readability for articles, DOM scraping for tweets, PDF.js for PDFs)
2. **Cleaning** -- strips markdown, HTML tags, processes URLs into readable form ("example dot com link"), replaces symbols with words
3. **Sentence splitting** -- splits on `.!?` boundaries while protecting abbreviations (Mr., Dr., etc.) and decimal numbers
4. **Chunking** -- groups sentences into chunks of ~500 characters max
5. **TTS** -- each chunk is sent as a `POST /v1/audio/speech` request to the local TTS server
6. **Pre-fetching** -- while chunk N plays, chunk N+1 is fetched in the background for gapless transitions
7. **Playback** -- audio plays in the offscreen document via an `<audio>` element with Web Audio API for routing

### TTS backends

Both backends expose an [OpenAI-compatible](https://platform.openai.com/docs/api-reference/audio/createSpeech) API, so the extension code is backend-agnostic.

**Kokoro-FastAPI** (default, port 8880) wraps the [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model in a FastAPI server with an OpenAI-compatible API. It runs in Docker with CPU inference via ONNX Runtime. 50+ voices across American English, British English, Japanese, and Chinese. The Docker image is published at `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4`.

**KittenTTS** (port 8881) is a lightweight TTS library (15M-80M parameter models) that only ships as a Python package -- no server, no Docker image. We wrote a FastAPI wrapper (`kittentts-server/server.py`) that exposes the same `/v1/audio/speech` and `/v1/audio/voices` endpoints. The wrapper handles voice mapping, audio encoding (via soundfile/numpy), and CORS. 8 English voices. The Dockerfile installs espeak-ng and ffmpeg as system dependencies.

## Third-party projects

| Project | What it does | Where it's used | License |
|---------|-------------|-----------------|---------|
| [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) | OpenAI-compatible API server for Kokoro-82M TTS model | Docker container on port 8880 | Apache 2.0 |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | 82M parameter text-to-speech model | Used by Kokoro-FastAPI | Apache 2.0 |
| [KittenTTS](https://github.com/KittenML/KittenTTS) | Lightweight TTS library (ONNX, CPU-optimized) | Wrapped in `kittentts-server/` | MIT |
| [Mozilla Readability](https://github.com/mozilla/readability) | Extracts article content from web pages (same engine as Firefox Reader View) | Bundled as `lib/readability.js`, injected as content script | Apache 2.0 |
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDF parsing and text extraction | Bundled as `lib/pdf.min.mjs` + `lib/pdf.worker.min.mjs` (v4.10.38), loaded in offscreen document | Apache 2.0 |
| [FastAPI](https://fastapi.tiangolo.com/) | Python web framework | KittenTTS server wrapper | MIT |
| [soundfile](https://github.com/bastibe/python-soundfile) | Audio encoding (WAV, MP3, FLAC, OGG) | KittenTTS server audio output | BSD-3-Clause |

### Forked from

This project is based on [local_tts_reader](https://github.com/phildougherty/local_tts_reader) by Phil Dougherty. The original was a simpler Chrome extension for Kokoro-FastAPI. Voxlocal is a substantial rewrite that adds PDF support, Twitter extraction, a second TTS backend, gapless pre-fetched playback, skip controls, a floating widget, text preprocessing, and the KittenTTS server wrapper.

## Quick start

### 1. Start a TTS server

```bash
# Clone this repo
git clone https://github.com/kargarisaac/voxlocal.git
cd voxlocal

# Start Kokoro TTS (recommended)
docker compose up -d kokoro-tts

# Or start both backends
docker compose up -d
```

Wait ~30 seconds for the model to load, then verify:

```bash
curl http://localhost:8880/health
# {"status":"healthy"}
```

### 2. Load the extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `voxlocal` folder
5. The extension icon appears in the toolbar

### 3. Read something

- **Read a page**: click the extension icon, then play
- **Read selected text**: select text, right-click, choose "Read aloud with Local TTS"
- **Read a PDF**: open a PDF in Chrome, click the extension icon, set page range, click "Read PDF"
- **Keyboard shortcuts**: `Alt+Shift+R` to read/pause, `Alt+Shift+S` to stop

## Configuration

Open the extension's **Settings** page (click "Settings" in the popup footer, or go to `chrome://extensions` and click "Options" on Voxlocal).

| Setting | Default | Description |
|---------|---------|-------------|
| Backend | Kokoro TTS | Which TTS server to use |
| Server URL | `http://localhost:8880/v1/audio/speech` | TTS API endpoint (auto-set when switching backend) |
| Voice | `af_heart` | TTS voice name |
| Speed | 1.0x | Playback speed (0.5x - 3.0x) |
| Auto Reader Mode | On | Use Readability to extract article content |
| Pre-process Text | On | Clean markdown, URLs, and symbols before TTS |
| Max Chunk Size | 500 | Characters per TTS request |

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+R` | Read page/selection, or toggle pause if already playing |
| `Alt+Shift+S` | Stop reading |

Customize at `chrome://extensions/shortcuts`.

## Docker services

| Service | Port | Image | Description |
|---------|------|-------|-------------|
| `kokoro-tts` | 8880 | `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4` | Kokoro TTS (CPU, ONNX) |
| `kittentts` | 8881 | Built from `kittentts-server/` | KittenTTS wrapper |

### Kokoro environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ONNX_NUM_THREADS` | `8` | CPU threads for ONNX inference |
| `ONNX_INTER_OP_THREADS` | `4` | Parallel operation threads |
| `CORS_ORIGINS` | `["*"]` | Allowed CORS origins |

### Listing available voices

```bash
# Kokoro
curl http://localhost:8880/v1/audio/voices

# KittenTTS
curl http://localhost:8881/v1/audio/voices
```

## Project structure

```
voxlocal/
  manifest.json                 Chrome MV3 manifest
  background.js                 Service worker: chunking, TTS calls, state management
  content.js                    Content script: text extraction, floating widget
  offscreen.html / offscreen.js Audio playback + PDF text extraction (offscreen document)
  popup.html / popup.js         Extension popup UI
  options.html / options.js     Settings page
  constants.js                  Backend definitions, default settings
  lib/
    readability.js              Mozilla Readability (bundled, ~91KB)
    pdf.min.mjs                 PDF.js main module (bundled, ~353KB)
    pdf.worker.min.mjs          PDF.js web worker (bundled, ~1.4MB)
  utils/
    textProcessor.js            Text cleaning, sentence splitting, chunking
    audioPlayer.js              Popup-side audio control abstraction
    pdfExtractor.js             PDF.js wrapper for text extraction
  icons/
    icon16.png / icon48.png / icon128.png
  kittentts-server/
    server.py                   FastAPI wrapper for KittenTTS library
    Dockerfile                  Python 3.12-slim + espeak-ng + ffmpeg
    requirements.txt            Python dependencies
  docker-compose.yml            Docker setup for both TTS backends
```

## Troubleshooting

**"Server offline" in popup**
- Check containers are running: `docker compose ps`
- Check logs: `docker compose logs kokoro-tts`
- Verify health: `curl http://localhost:8880/health`

**No text extracted**
- Wait for SPAs to finish loading
- Try selecting text manually and using right-click > "Read aloud with Local TTS"
- Check the browser console for errors (right-click extension icon > Inspect popup)

**PDF not working**
- Remote PDFs (http/https) should work out of the box
- For local `file://` PDFs, enable "Allow access to file URLs" in `chrome://extensions/` for Voxlocal
- arxiv PDFs (`/pdf/` in URL) are detected automatically

**Audio issues**
- Try a different voice or lower speed
- Restart the TTS server: `docker compose restart kokoro-tts`
- Check the offscreen document console: go to `chrome://extensions`, find Voxlocal, click "Inspect views: offscreen.html"

## Requirements

- Chrome 120+ (MV3 offscreen document support)
- Docker and Docker Compose (for TTS servers)
- ~2GB disk for Kokoro Docker image (includes model weights)
- CPU inference only -- no GPU required

## License

MIT License. See [LICENSE](LICENSE).

## Acknowledgments

- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) by remsky
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad
- [KittenTTS](https://github.com/KittenML/KittenTTS) by KittenML
- [local_tts_reader](https://github.com/phildougherty/local_tts_reader) by Phil Dougherty (original extension this project is based on)
- [Mozilla Readability](https://github.com/mozilla/readability) by Mozilla
- [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla
