# Contributing to Voxlocal

Thanks for your interest in contributing!

## Development setup

1. Clone the repo and start the backend services:

   ```bash
   ollama serve &
   ollama pull qwen3.5:35b
   docker compose up -d
   ```

2. Load the extension in Chrome:

   - Open `chrome://extensions/`, enable **Developer mode**
   - Click **Load unpacked** and select the `extension/` directory
   - After editing extension files, click the reload button on the extensions page

3. Server code lives in `servers/`. After editing, rebuild with:

   ```bash
   docker compose up -d --build chat-server
   ```

## Project layout

```
extension/    Chrome extension (load unpacked from here)
servers/
  chat/       FastAPI chat server (Ollama streaming)
```

## Guidelines

- **No build step.** The extension is vanilla JS — no bundlers, no transpilers.
- **No cloud APIs.** Everything must run locally.
- **Keep dependencies minimal.** Third-party libs go in `extension/lib/` as pre-built files.
- **Test manually** by reloading the unpacked extension and exercising the feature in the side panel.

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Open a pull request with a clear description of what changed and why

## Reporting bugs

Open an issue with:
- What you expected vs. what happened
- Chrome version, OS, and which TTS backend you're using
- Any errors from the Chrome DevTools console or `docker compose logs`
