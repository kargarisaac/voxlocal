/**
 * Popup script for Local TTS Reader.
 */
(function () {
  'use strict';

  let audioPlayer = null;
  let seekUpdateInterval = null;

  // ─── DOM References ───────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  const els = {};

  function initEls() {
    els.errorBanner   = $('errorBanner');
    els.statusDot     = $('statusDot');
    els.statusText    = $('statusText');
    els.chunkInfo     = $('chunkInfo');
    els.prevBtn       = $('prevBtn');
    els.playBtn       = $('playBtn');
    els.pauseBtn      = $('pauseBtn');
    els.stopBtn       = $('stopBtn');
    els.nextBtn       = $('nextBtn');
    els.loadingOverlay = $('loadingOverlay');
    els.seekBar       = $('seekBar');
    els.currentTime   = $('currentTime');
    els.duration      = $('duration');
    els.voice         = $('voice');
    els.speed         = $('speed');
    els.speedVal      = $('speedVal');
    els.refreshVoicesBtn = $('refreshVoicesBtn');
    els.pdfSection    = $('pdfSection');
    els.pdfPageStart  = $('pdfPageStart');
    els.pdfPageEnd    = $('pdfPageEnd');
    els.readPdfBtn    = $('readPdfBtn');
    els.serverDot     = $('serverDot');
    els.serverLabel   = $('serverLabel');
    els.settingsLink  = $('settingsLink');
  }

  // ─── Formatting ───────────────────────────────────────────────────

  function formatTime(sec) {
    if (isNaN(sec) || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ─── Error Display ────────────────────────────────────────────────

  function showError(msg) {
    els.errorBanner.textContent = msg;
    els.errorBanner.classList.add('visible');
    setTimeout(() => els.errorBanner.classList.remove('visible'), 8000);
  }

  function clearError() {
    els.errorBanner.classList.remove('visible');
  }

  // ─── UI State ─────────────────────────────────────────────────────

  function updateUI(state, chunkIndex, totalChunks) {
    // Status dot
    els.statusDot.className = 'status-dot ' + (state || '');

    // Status text
    const labels = {
      stopped: 'Ready',
      loading: 'Loading...',
      playing: 'Playing',
      paused: 'Paused'
    };
    els.statusText.textContent = labels[state] || 'Ready';

    // Chunk info
    if (totalChunks > 0 && chunkIndex >= 0) {
      els.chunkInfo.textContent = 'Chunk ' + (chunkIndex + 1) + ' / ' + totalChunks;
    } else {
      els.chunkInfo.textContent = '';
    }

    // Loading overlay
    els.loadingOverlay.classList.toggle('visible', state === 'loading');

    // Button states
    els.playBtn.disabled  = state === 'loading';
    els.pauseBtn.disabled = state !== 'playing';
    els.stopBtn.disabled  = state === 'stopped' || state === 'loading';
    els.prevBtn.disabled  = !totalChunks || chunkIndex <= 0;
    els.nextBtn.disabled  = !totalChunks || chunkIndex >= totalChunks - 1;
    els.seekBar.disabled  = state === 'stopped' || state === 'loading';

    // Show/hide play vs pause
    els.playBtn.style.display  = state === 'playing' ? 'none' : 'flex';
    els.pauseBtn.style.display = state === 'playing' ? 'flex' : 'none';

    if (state === 'stopped') {
      els.seekBar.value = 0;
      els.currentTime.textContent = '0:00';
      els.duration.textContent = '0:00';
    }
  }

  // ─── Settings ─────────────────────────────────────────────────────

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
        resolve(result);
      });
    });
  }

  function getCurrentSettings() {
    return {
      voice: els.voice.value,
      speed: parseFloat(els.speed.value),
      serverUrl: undefined,  // will use stored
      preprocessText: undefined,
      autoReaderMode: undefined,
      maxChunkSize: undefined
    };
  }

  async function saveVoiceAndSpeed() {
    await chrome.storage.local.set({
      voice: els.voice.value,
      speed: parseFloat(els.speed.value)
    });
  }

  // ─── Voice List ───────────────────────────────────────────────────

  async function loadVoices(forceRefresh) {
    let voices = [];

    if (!forceRefresh) {
      const cached = await chrome.storage.local.get('cachedVoices');
      voices = cached.cachedVoices || [];
    }

    if (voices.length === 0 || forceRefresh) {
      voices = await audioPlayer.fetchVoices();
    }

    populateVoiceDropdown(voices);
  }

  function populateVoiceDropdown(voices) {
    const current = els.voice.value;
    els.voice.innerHTML = '';

    if (!voices || voices.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'af_heart';
      opt.textContent = 'af_heart (default)';
      els.voice.appendChild(opt);
      return;
    }

    voices.sort();
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      els.voice.appendChild(opt);
    }

    // Restore selection
    if (current && voices.includes(current)) {
      els.voice.value = current;
    }
  }

  // ─── PDF Detection ────────────────────────────────────────────────

  function looksLikePdfUrl(url) {
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

  async function checkForPdf() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length === 0) return;

      const url = tabs[0].url || '';

      // Quick URL check
      if (looksLikePdfUrl(url)) {
        els.pdfSection.classList.add('visible');
        els.readPdfBtn.dataset.pdfUrl = url;
        return;
      }

      // Also ask content script if it detected a PDF embed
      try {
        const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'extractText', useReaderMode: false });
        if (result && result.source === 'pdf' && result.pdfUrl) {
          els.pdfSection.classList.add('visible');
          els.readPdfBtn.dataset.pdfUrl = result.pdfUrl;
        }
      } catch (_) {}
    } catch (e) {
      // Ignore
    }
  }

  // ─── Health Check ─────────────────────────────────────────────────

  async function checkServerHealth() {
    const result = await audioPlayer.checkHealth();
    if (result.healthy) {
      els.serverDot.className = 'dot ok';
      els.serverLabel.textContent = 'Server online';
    } else {
      els.serverDot.className = 'dot err';
      els.serverLabel.textContent = 'Server offline';
    }
  }

  // ─── Seek Bar Updates ─────────────────────────────────────────────

  function startSeekUpdates() {
    stopSeekUpdates();
    seekUpdateInterval = setInterval(async () => {
      const timeInfo = await audioPlayer.getTimeInfo();
      if (timeInfo && !els.seekBar.classList.contains('seeking')) {
        els.seekBar.max = timeInfo.duration || 100;
        els.seekBar.value = timeInfo.currentTime || 0;
        els.currentTime.textContent = formatTime(timeInfo.currentTime);
        els.duration.textContent = formatTime(timeInfo.duration);
      }
    }, 500);
  }

  function stopSeekUpdates() {
    if (seekUpdateInterval) {
      clearInterval(seekUpdateInterval);
      seekUpdateInterval = null;
    }
  }

  // ─── Event Handlers ───────────────────────────────────────────────

  function setupEventListeners() {
    // Play button
    els.playBtn.addEventListener('click', async () => {
      clearError();
      const stateInfo = await audioPlayer.getState();

      if (stateInfo.state === 'paused') {
        audioPlayer.resume();
        updateUI('playing', stateInfo.chunkIndex, stateInfo.totalChunks);
        startSeekUpdates();
        return;
      }

      // Start fresh reading
      const stored = await getSettings();
      const settings = {
        ...stored,
        voice: els.voice.value,
        speed: parseFloat(els.speed.value)
      };

      await saveVoiceAndSpeed();
      updateUI('loading', 0, 0);
      audioPlayer.startReading(settings);
      startSeekUpdates();
    });

    // Pause button
    els.pauseBtn.addEventListener('click', () => {
      audioPlayer.pause();
    });

    // Stop button
    els.stopBtn.addEventListener('click', () => {
      audioPlayer.stop();
      updateUI('stopped', -1, 0);
      stopSeekUpdates();
    });

    // Skip buttons
    els.prevBtn.addEventListener('click', () => audioPlayer.skipPrev());
    els.nextBtn.addEventListener('click', () => audioPlayer.skipNext());

    // Seek bar
    els.seekBar.addEventListener('mousedown', () => {
      els.seekBar.classList.add('seeking');
    });
    els.seekBar.addEventListener('input', () => {
      els.currentTime.textContent = formatTime(parseFloat(els.seekBar.value));
    });
    els.seekBar.addEventListener('change', async () => {
      await audioPlayer.seek(parseFloat(els.seekBar.value));
      els.seekBar.classList.remove('seeking');
    });

    // Speed slider
    els.speed.addEventListener('input', () => {
      els.speedVal.textContent = parseFloat(els.speed.value).toFixed(1) + 'x';
    });
    els.speed.addEventListener('change', saveVoiceAndSpeed);

    // Voice selection
    els.voice.addEventListener('change', saveVoiceAndSpeed);

    // Refresh voices
    els.refreshVoicesBtn.addEventListener('click', () => {
      loadVoices(true);
    });

    // PDF read button
    els.readPdfBtn.addEventListener('click', async () => {
      clearError();
      const url = els.readPdfBtn.dataset.pdfUrl;
      if (!url) {
        showError('No PDF URL found');
        return;
      }

      const stored = await getSettings();
      const settings = {
        ...stored,
        voice: els.voice.value,
        speed: parseFloat(els.speed.value)
      };

      const pageStart = parseInt(els.pdfPageStart.value) || 1;
      const pageEnd = els.pdfPageEnd.value ? parseInt(els.pdfPageEnd.value) : null;

      await saveVoiceAndSpeed();
      updateUI('loading', 0, 0);
      audioPlayer.readPdf(url, pageStart, pageEnd, settings);
      startSeekUpdates();
    });

    // Settings link
    els.settingsLink.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // ─── Message Listener ─────────────────────────────────────────────

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      switch (message.type) {
        case 'playerStateUpdate':
          updateUI(message.state, message.chunkIndex, message.totalChunks);
          if (message.state === 'playing') {
            startSeekUpdates();
          } else if (message.state === 'stopped') {
            stopSeekUpdates();
          }
          break;

        case 'streamError':
          showError(message.error || 'Unknown error');
          updateUI('stopped', -1, 0);
          stopSeekUpdates();
          break;

        case 'timeUpdate':
          if (message.timeInfo && !els.seekBar.classList.contains('seeking')) {
            els.seekBar.max = message.timeInfo.duration || 100;
            els.seekBar.value = message.timeInfo.currentTime || 0;
            els.currentTime.textContent = formatTime(message.timeInfo.currentTime);
            els.duration.textContent = formatTime(message.timeInfo.duration);
          }
          break;
      }
    });
  }

  // ─── Sync State on Popup Open ─────────────────────────────────────

  async function syncState() {
    const stateInfo = await audioPlayer.getState();
    updateUI(stateInfo.state, stateInfo.chunkIndex, stateInfo.totalChunks);

    if (stateInfo.state === 'playing' || stateInfo.state === 'paused') {
      startSeekUpdates();
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    initEls();

    audioPlayer = new AudioPlayer();
    await audioPlayer.init();

    // Load settings
    const settings = await getSettings();
    els.speed.value = settings.speed || 1.0;
    els.speedVal.textContent = (settings.speed || 1.0).toFixed(1) + 'x';

    // Set initial voice (will be overwritten when list loads)
    if (settings.voice) {
      els.voice.value = settings.voice;
    }

    setupEventListeners();
    setupMessageListener();

    // Run in parallel: sync state, load voices, check PDF, health
    syncState();
    loadVoices(false);
    checkForPdf();
    checkServerHealth();
  });

})();
