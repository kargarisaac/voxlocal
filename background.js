/**
 * Background service worker for Local TTS Reader.
 * Orchestrates text extraction, chunking, TTS API calls, and audio playback.
 */
importScripts('constants.js', 'utils/textProcessor.js');

// ─── State ───────────────────────────────────────────────────────────

let playerState = 'stopped'; // stopped | loading | playing | paused
let chunks = [];
let currentChunkIndex = -1;
let totalChunks = 0;
let currentSettings = {};
let prefetchedAudio = new Map(); // chunkIndex -> { data, mimeType }
let activeTabId = null;
let abortController = null;

// ─── Offscreen Document ──────────────────────────────────────────────

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Playing TTS audio and extracting PDF text'
  });
}

// ─── Settings ────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(result);
    });
  });
}

function getBackendUrls(settings) {
  const backendKey = settings.backend || 'kokoro';
  const backend = BACKENDS[backendKey] || BACKENDS.kokoro;
  return {
    speechUrl: settings.serverUrl || backend.speechUrl,
    voicesUrl: backend.voicesUrl,
    healthUrl: backend.healthUrl
  };
}

// ─── Targeted Messaging ─────────────────────────────────────────────

/**
 * Send a message targeted to the offscreen document only.
 * Uses a target field so the offscreen listener can filter.
 */
function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }).catch(() => {});
}

// ─── State Broadcasting ─────────────────────────────────────────────

function broadcastState(state, extra) {
  playerState = state;
  const msg = {
    type: 'playerStateUpdate',
    state: state,
    chunkIndex: currentChunkIndex,
    totalChunks: totalChunks,
    ...extra
  };

  chrome.runtime.sendMessage(msg).catch(() => {});

  // Update floating widget on the active tab
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: state === 'stopped' ? 'hideWidget' : 'updateWidget',
      state: state,
      chunkIndex: currentChunkIndex,
      totalChunks: totalChunks
    }).catch(() => {});
  }
}

function broadcastError(errorMsg) {
  chrome.runtime.sendMessage({
    type: 'streamError',
    error: errorMsg
  }).catch(() => {});
  broadcastState('stopped');
}

// ─── TTS API ─────────────────────────────────────────────────────────

async function fetchAudioForChunk(text, settings, signal) {
  const urls = getBackendUrls(settings);

  const body = {
    model: 'kokoro',
    voice: settings.voice || 'af_heart',
    input: text,
    speed: parseFloat(settings.speed) || 1.0,
    stream: false,
    response_format: 'mp3'
  };

  const response = await fetch(urls.speechUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg, audio/wav, audio/*'
    },
    body: JSON.stringify(body),
    signal: signal
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`TTS server error (${response.status}): ${errText || response.statusText}`);
  }

  const blob = await response.blob();
  const mimeType = blob.type || 'audio/mpeg';
  const arrayBuffer = await blob.arrayBuffer();

  return {
    data: Array.from(new Uint8Array(arrayBuffer)),
    mimeType: mimeType
  };
}

// ─── Chunk Playback Pipeline ─────────────────────────────────────────

async function startChunkPlayback(chunkIndex) {
  if (chunkIndex >= totalChunks) {
    // All chunks done
    broadcastState('stopped');
    return;
  }

  currentChunkIndex = chunkIndex;
  broadcastState('loading');

  try {
    // Check if we already prefetched this chunk
    let audio;
    if (prefetchedAudio.has(chunkIndex)) {
      audio = prefetchedAudio.get(chunkIndex);
      prefetchedAudio.delete(chunkIndex);
    } else {
      audio = await fetchAudioForChunk(
        chunks[chunkIndex],
        currentSettings,
        abortController ? abortController.signal : undefined
      );
    }

    // Send audio to offscreen for playback
    await ensureOffscreen();
    sendToOffscreen({
      type: 'playAudioChunk',
      audioData: audio.data,
      mimeType: audio.mimeType,
      chunkIndex: chunkIndex
    });

    broadcastState('playing');

    // Pre-fetch next chunk
    prefetchNextChunk(chunkIndex + 1);

  } catch (error) {
    if (error.name === 'AbortError') return; // Cancelled
    console.error('Error playing chunk:', error);
    broadcastError(error.message);
  }
}

async function prefetchNextChunk(nextIndex) {
  if (nextIndex >= totalChunks) return;
  if (prefetchedAudio.has(nextIndex)) return;

  try {
    const audio = await fetchAudioForChunk(
      chunks[nextIndex],
      currentSettings,
      abortController ? abortController.signal : undefined
    );
    prefetchedAudio.set(nextIndex, audio);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.warn('Prefetch failed for chunk', nextIndex, error);
    }
  }
}

// ─── Reading Orchestration ───────────────────────────────────────────

async function startReading(settings) {
  // Stop any current playback
  stopPlayback();

  currentSettings = settings;
  abortController = new AbortController();

  // Get active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    broadcastError('No active tab found');
    return;
  }

  activeTabId = tabs[0].id;
  const tabUrl = tabs[0].url || '';

  // Check if this is a PDF
  if (isPdfUrl(tabUrl)) {
    broadcastError('This is a PDF page. Use the PDF reader with page range in the popup.');
    return;
  }

  broadcastState('loading');

  // Show widget
  chrome.tabs.sendMessage(activeTabId, {
    type: 'showWidget',
    state: 'loading',
    chunkIndex: 0,
    totalChunks: 0
  }).catch(() => {});

  try {
    // Extract text via content script
    let result;
    try {
      result = await chrome.tabs.sendMessage(activeTabId, {
        type: 'extractText',
        useReaderMode: settings.autoReaderMode !== false
      });
    } catch (e) {
      // Content script not loaded - try injecting
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          files: ['lib/readability.js', 'content.js']
        });
        result = await chrome.tabs.sendMessage(activeTabId, {
          type: 'extractText',
          useReaderMode: settings.autoReaderMode !== false
        });
      } catch (e2) {
        throw new Error('Cannot access this page. Try a different tab.');
      }
    }

    if (!result || (!result.text && result.source !== 'pdf')) {
      throw new Error('No text found on this page.');
    }

    if (result.source === 'pdf') {
      broadcastError('This is a PDF page. Use the PDF reader in the popup.');
      return;
    }

    let text = result.text;

    // Pre-process text
    if (settings.preprocessText !== false) {
      text = TextProcessor.process(text);
    }

    if (!text || text.trim().length === 0) {
      throw new Error('No readable text found on this page.');
    }

    // Split into chunks
    const maxChunkSize = settings.maxChunkSize || 500;
    chunks = TextProcessor.chunkText(text, maxChunkSize);
    totalChunks = chunks.length;

    if (totalChunks === 0) {
      throw new Error('No text to read.');
    }

    // Start playback from first chunk
    await startChunkPlayback(0);

  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Error in startReading:', error);
    broadcastError(error.message);
  }
}

async function readPdf(url, pageStart, pageEnd, settings) {
  stopPlayback();

  currentSettings = settings;
  abortController = new AbortController();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs && tabs.length > 0 ? tabs[0].id : null;

  broadcastState('loading');

  try {
    // Fetch the PDF
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();

    // Send to offscreen for PDF.js extraction
    await ensureOffscreen();
    const result = await sendToOffscreen({
      type: 'extractPdfText',
      pdfData: Array.from(new Uint8Array(arrayBuffer)),
      pageStart: pageStart || 1,
      pageEnd: pageEnd || null
    });

    if (result && result.error) {
      throw new Error(result.error);
    }

    if (!result || !result.result || !result.result.pages) {
      throw new Error('Failed to extract text from PDF');
    }

    // Combine page texts
    let text = result.result.pages
      .map(p => p.text)
      .filter(t => t && t.trim().length > 0)
      .join(' ');

    // Pre-process
    if (settings.preprocessText !== false) {
      text = TextProcessor.process(text);
    }

    if (!text || text.trim().length === 0) {
      throw new Error('No readable text found in this PDF.');
    }

    // Chunk and play
    const maxChunkSize = settings.maxChunkSize || 500;
    chunks = TextProcessor.chunkText(text, maxChunkSize);
    totalChunks = chunks.length;

    if (totalChunks === 0) {
      throw new Error('No text to read from PDF.');
    }

    await startChunkPlayback(0);

  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Error reading PDF:', error);
    broadcastError(error.message);
  }
}

// ─── Playback Controls ───────────────────────────────────────────────

function stopPlayback() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  chunks = [];
  currentChunkIndex = -1;
  totalChunks = 0;
  prefetchedAudio.clear();
  playerState = 'stopped';

  // Tell offscreen to stop
  sendToOffscreen({ type: 'stop' });

  // Hide widget
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'hideWidget' }).catch(() => {});
  }
}

function pausePlayback() {
  sendToOffscreen({ type: 'pause' });
}

function resumePlayback() {
  sendToOffscreen({ type: 'play' });
}

function skipChunk(direction) {
  if (totalChunks === 0) return;

  let newIndex;
  if (direction === 'next') {
    newIndex = currentChunkIndex + 1;
    if (newIndex >= totalChunks) return; // Already at end
  } else {
    newIndex = currentChunkIndex - 1;
    if (newIndex < 0) newIndex = 0;
  }

  // Clear queued audio but do NOT send 'stop' — playChunk will replace
  // the current audio directly, avoiding the stale stateUpdate:stopped race
  sendToOffscreen({ type: 'clearQueue' });

  // Abort any in-flight prefetch for the old sequence
  if (abortController) abortController.abort();
  abortController = new AbortController();

  // Start new chunk (playChunk replaces the audio element's src directly)
  startChunkPlayback(newIndex);
}

// ─── Voice List ──────────────────────────────────────────────────────

async function fetchVoices(settings) {
  const urls = getBackendUrls(settings || await getSettings());
  try {
    const response = await fetch(urls.voicesUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Voice list request failed: ${response.status}`);
    }

    const data = await response.json();
    const voices = data.voices || [];

    // Cache voices
    await chrome.storage.local.set({ cachedVoices: voices });
    return voices;

  } catch (error) {
    console.warn('Failed to fetch voices:', error);
    // Try cached
    const stored = await chrome.storage.local.get('cachedVoices');
    return stored.cachedVoices || [];
  }
}

// ─── Health Check ────────────────────────────────────────────────────

async function checkHealth(settings) {
  const urls = getBackendUrls(settings || await getSettings());
  try {
    const response = await fetch(urls.healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });

    if (response.ok) {
      return { healthy: true };
    }
    return { healthy: false, error: `HTTP ${response.status}` };

  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

// ─── Utility ─────────────────────────────────────────────────────────

function isPdfUrl(url) {
  if (!url) return false;
  // .pdf with optional query/hash
  if (url.match(/\.pdf(\?|#|$)/i)) return true;
  // Chrome internal PDF viewer
  if (url.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) return true;
  // Path contains /pdf/ or ends with /pdf (arxiv, etc.)
  try {
    const pathname = new URL(url).pathname;
    if (/\/pdf(\/|$)/i.test(pathname)) return true;
  } catch (_) {}
  return false;
}

// ─── Context Menu ────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'readAloudTTS',
      title: 'Read aloud with Voxlocal',
      contexts: ['selection', 'page']
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'readAloudTTS') return;

  const settings = await getSettings();

  if (info.selectionText) {
    // Read selected text directly
    stopPlayback();
    currentSettings = settings;
    abortController = new AbortController();
    activeTabId = tab.id;

    let text = info.selectionText;
    if (settings.preprocessText !== false) {
      text = TextProcessor.process(text);
    }

    const maxChunkSize = settings.maxChunkSize || 500;
    chunks = TextProcessor.chunkText(text, maxChunkSize);
    totalChunks = chunks.length;

    if (totalChunks > 0) {
      // Show widget
      chrome.tabs.sendMessage(tab.id, {
        type: 'showWidget',
        state: 'loading',
        chunkIndex: 0,
        totalChunks: totalChunks
      }).catch(() => {});

      await startChunkPlayback(0);
    }
  } else {
    // Read full page
    activeTabId = tab.id;
    startReading(settings);
  }
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'read-aloud') {
    const settings = await getSettings();
    if (playerState === 'playing') {
      pausePlayback();
    } else if (playerState === 'paused') {
      resumePlayback();
    } else {
      startReading(settings);
    }
  } else if (command === 'stop-reading') {
    stopPlayback();
    broadcastState('stopped');
  }
});

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'setupOffscreen':
      ensureOffscreen()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'startReading':
      startReading(message.settings);
      sendResponse({ ok: true });
      return false;

    case 'readPdf':
      readPdf(message.url, message.pageStart, message.pageEnd, message.settings);
      sendResponse({ ok: true });
      return false;

    case 'controlAudio':
      if (message.action === 'play') resumePlayback();
      else if (message.action === 'pause') pausePlayback();
      else if (message.action === 'stop') {
        stopPlayback();
        broadcastState('stopped');
      }
      sendResponse({ ok: true });
      return false;

    case 'skipChunk':
      skipChunk(message.direction);
      sendResponse({ ok: true });
      return false;

    case 'getPlayerState':
      sendResponse({
        state: playerState,
        chunkIndex: currentChunkIndex,
        totalChunks: totalChunks
      });
      return false; // synchronous response

    case 'getTimeInfo':
      // Forward to offscreen via targeted message
      sendToOffscreen({ type: 'getTimeInfo' })
        .then(response => sendResponse(response))
        .catch(() => sendResponse({ timeInfo: null }));
      return true;

    case 'seekInChunk':
      sendToOffscreen({ type: 'seek', time: message.time })
        .then(response => sendResponse(response))
        .catch(() => sendResponse({ success: false }));
      return true;

    case 'fetchVoices':
      fetchVoices(message.settings)
        .then(voices => sendResponse({ voices }))
        .catch(() => sendResponse({ voices: [] }));
      return true;

    case 'checkHealth':
      checkHealth(message.settings)
        .then(result => sendResponse(result))
        .catch(() => sendResponse({ healthy: false }));
      return true;

    // ─── Forwarded from offscreen ───
    case 'chunkPlaybackEnded':
      // Current chunk finished, play next
      if (message.chunkIndex !== undefined) {
        const nextIndex = message.chunkIndex + 1;
        if (nextIndex < totalChunks) {
          startChunkPlayback(nextIndex);
        } else {
          broadcastState('stopped');
        }
      }
      return false;

    case 'stateUpdate':
      // From offscreen: audio state changed
      if (message.state === 'playing') {
        broadcastState('playing');
      } else if (message.state === 'paused') {
        broadcastState('paused');
      } else if (message.state === 'stopped') {
        // Only update if we're not transitioning between chunks
        if (playerState !== 'loading') {
          broadcastState('stopped');
        }
      }
      return false;

    case 'audioTimeUpdate':
      // Forward time updates to popup
      chrome.runtime.sendMessage({
        type: 'timeUpdate',
        timeInfo: message.timeInfo
      }).catch(() => {});
      return false;

    case 'streamError':
      // Error from offscreen
      if (sender.url && sender.url.includes('offscreen')) {
        broadcastError(message.error);
      }
      return false;

    default:
      return false;
  }
});

// ─── Init ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

// Re-create context menu on startup (in case service worker was killed)
chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});
