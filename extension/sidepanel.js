/**
 * Side panel script for Voxlocal.
 * Combines TTS controls (migrated from popup.js) and chat with page content.
 */
(function () {
  'use strict';

  let audioPlayer = null;
  let seekUpdateInterval = null;

  // Inline TTS player for AI chat responses (independent from page TTS)
  const inlinePlayer = {
    audio: null,
    abortController: null,
    activeBtn: null,
    chunks: [],
    currentChunk: -1,
    totalChunks: 0
  };

  // Chat state
  let chatSessionId = null;
  let chatServerUrl = 'http://localhost:8882';
  let isChatStreaming = false;

  // Tab ↔ chat session persistence
  const tabSessions = new Map(); // tabId → { sessionId, messagesHTML }
  let currentTabId = null;

  // Configure marked for markdown rendering
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
  }

  function renderMarkdown(text) {
    if (!text) return '';
    try {
      return marked.parse(text);
    } catch (_) {
      // Fallback: escape HTML and preserve newlines
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  }

  // ─── DOM References ───────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const els = {};

  function initEls() {
    // TTS
    els.errorBanner     = $('errorBanner');
    els.statusDot       = $('statusDot');
    els.statusText      = $('statusText');
    els.chunkInfo       = $('chunkInfo');
    els.prevBtn         = $('prevBtn');
    els.playBtn         = $('playBtn');
    els.pauseBtn        = $('pauseBtn');
    els.stopBtn         = $('stopBtn');
    els.nextBtn         = $('nextBtn');
    els.loadingOverlay  = $('loadingOverlay');
    els.seekBar         = $('seekBar');
    els.currentTime     = $('currentTime');
    els.duration        = $('duration');
    els.voice           = $('voice');
    els.speed           = $('speed');
    els.speedVal        = $('speedVal');
    els.refreshVoicesBtn = $('refreshVoicesBtn');
    els.pdfSection      = $('pdfSection');
    els.pdfPageStart    = $('pdfPageStart');
    els.pdfPageEnd      = $('pdfPageEnd');
    els.readPdfBtn      = $('readPdfBtn');
    els.serverDot       = $('serverDot');
    els.serverLabel     = $('serverLabel');
    els.settingsLink    = $('settingsLink');

    // Chat
    els.chatMessages    = $('chatMessages');
    els.chatInput       = $('chatInput');
    els.sendBtn         = $('sendBtn');
    els.chatDot         = $('chatDot');
    els.chatLabel       = $('chatLabel');
    els.chatWelcome     = $('chatWelcome');
    els.modelSelect     = $('modelSelect');
    els.newChatBtn      = $('newChatBtn');
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

  // ─── TTS UI State ─────────────────────────────────────────────────

  function updateUI(state, chunkIndex, totalChunks) {
    els.statusDot.className = 'status-dot ' + (state || '');
    const labels = { stopped: 'Ready', loading: 'Loading...', playing: 'Playing', paused: 'Paused' };
    els.statusText.textContent = labels[state] || 'Ready';

    if (totalChunks > 0 && chunkIndex >= 0) {
      els.chunkInfo.textContent = 'Chunk ' + (chunkIndex + 1) + ' / ' + totalChunks;
    } else {
      els.chunkInfo.textContent = '';
    }

    els.loadingOverlay.classList.toggle('visible', state === 'loading');
    els.playBtn.disabled  = state === 'loading';
    els.pauseBtn.disabled = state !== 'playing';
    els.stopBtn.disabled  = state === 'stopped' || state === 'loading';
    els.prevBtn.disabled  = !totalChunks || chunkIndex <= 0;
    els.nextBtn.disabled  = !totalChunks || chunkIndex >= totalChunks - 1;
    els.seekBar.disabled  = state === 'stopped' || state === 'loading';
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
      chrome.storage.local.get(DEFAULT_SETTINGS, (result) => resolve(result));
    });
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
    if (current && voices.includes(current)) {
      els.voice.value = current;
    }
  }

  // ─── PDF Detection ────────────────────────────────────────────────

  function looksLikePdfUrl(url) {
    if (!url) return false;
    if (url.match(/\.pdf(\?|#|$)/i)) return true;
    if (url.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) return true;
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
      if (looksLikePdfUrl(url)) {
        els.pdfSection.classList.add('visible');
        els.readPdfBtn.dataset.pdfUrl = url;
        return;
      }
      try {
        const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'extractText', useReaderMode: false });
        if (result && result.source === 'pdf' && result.pdfUrl) {
          els.pdfSection.classList.add('visible');
          els.readPdfBtn.dataset.pdfUrl = result.pdfUrl;
        }
      } catch (_) {}
    } catch (_) {}
  }

  // ─── Health Checks ────────────────────────────────────────────────

  async function checkServerHealth() {
    const result = await audioPlayer.checkHealth();
    els.serverDot.className = 'dot ' + (result.healthy ? 'ok' : 'err');
    els.serverLabel.textContent = result.healthy ? 'TTS online' : 'TTS offline';
  }

  async function checkChatHealth() {
    try {
      const resp = await fetch(chatServerUrl + '/health', { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        els.chatDot.className = 'dot ok';
        els.chatLabel.textContent = 'LLM online';
        els.sendBtn.disabled = false;
        return true;
      }
    } catch (_) {}
    els.chatDot.className = 'dot err';
    els.chatLabel.textContent = 'LLM offline';
    els.sendBtn.disabled = true;
    return false;
  }

  // ─── Model List ────────────────────────────────────────────────────

  async function loadModels() {
    try {
      const resp = await fetch(chatServerUrl + '/models', { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return;
      const data = await resp.json();
      const models = data.models || [];
      const defaultModel = data.default || '';

      els.modelSelect.innerHTML = '';
      if (models.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models found';
        els.modelSelect.appendChild(opt);
        return;
      }

      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.name;
        const sizeLabel = m.size ? ' (' + m.size + ')' : '';
        opt.textContent = m.name + sizeLabel;
        els.modelSelect.appendChild(opt);
      }

      // Select the default model
      if (defaultModel && models.some(m => m.name === defaultModel)) {
        els.modelSelect.value = defaultModel;
      }

      // Persist selection
      const stored = await chrome.storage.local.get('chatModel');
      if (stored.chatModel && models.some(m => m.name === stored.chatModel)) {
        els.modelSelect.value = stored.chatModel;
      }
    } catch (e) {
      console.warn('Failed to load models:', e);
      els.modelSelect.innerHTML = '<option value="">Models unavailable</option>';
    }
  }

  // ─── Seek Bar ─────────────────────────────────────────────────────

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

  // ─── Tab Session Persistence ────────────────────────────────────────

  function saveTabSession() {
    if (currentTabId && chatSessionId) {
      tabSessions.set(currentTabId, {
        sessionId: chatSessionId,
        messagesHTML: els.chatMessages.innerHTML
      });
    }
  }

  function restoreTabSession(tabId) {
    const saved = tabSessions.get(tabId);
    if (saved && saved.sessionId) {
      chatSessionId = saved.sessionId;
      els.chatMessages.innerHTML = saved.messagesHTML;
      els.chatWelcome = $('chatWelcome');
      els.sendBtn.disabled = false;
      return true;
    }
    return false;
  }

  // ─── Chat ─────────────────────────────────────────────────────────

  async function initChatSession() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) return;

      // Extract text from current page
      let result;
      try {
        result = await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'extractText',
          useReaderMode: true
        });
      } catch (_) {
        // Content script not loaded yet, try injecting
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            files: ['lib/readability.js', 'content.js']
          });
          result = await chrome.tabs.sendMessage(tabs[0].id, {
            type: 'extractText',
            useReaderMode: true
          });
        } catch (_) {
          return;
        }
      }

      if (!result) return;

      const pageUrl = tabs[0].url || '';
      const pageTitle = tabs[0].title || '';
      let pageText = result.text || '';

      // For PDFs, extract text via background/offscreen pipeline
      if (result.source === 'pdf' && result.pdfUrl) {
        try {
          const pdfResult = await chrome.runtime.sendMessage({
            type: 'extractPdfForChat',
            url: result.pdfUrl
          });
          if (pdfResult && pdfResult.text) {
            pageText = pdfResult.text;
          } else {
            els.chatWelcome.textContent = 'PDF detected but text extraction failed. Use the PDF reader for TTS.';
            return;
          }
        } catch (e) {
          console.warn('PDF extraction for chat failed:', e);
          els.chatWelcome.textContent = 'PDF detected but text extraction failed.';
          return;
        }
      }

      if (!pageText) return;

      // Create session with chat server
      const resp = await fetch(chatServerUrl + '/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: pageText,
          url: pageUrl,
          title: pageTitle
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        chatSessionId = data.session_id;
        const label = result.source === 'pdf' ? 'PDF loaded' : 'Page loaded';
        els.chatWelcome.textContent = label + ': ' + (pageTitle || 'Untitled') + '. Ask anything about it.';
        els.sendBtn.disabled = false;
        saveTabSession();
      }
    } catch (e) {
      console.warn('Failed to init chat session:', e);
    }
  }

  async function sendChatMessage() {
    const text = els.chatInput.value.trim();
    if (!text || isChatStreaming || !chatSessionId) return;

    els.chatInput.value = '';
    autoResizeInput();
    isChatStreaming = true;
    els.sendBtn.disabled = true;

    // Add user message
    appendMessage('user', text);

    // Create AI message placeholder
    const aiMsgEl = appendMessage('ai', '', true);
    const contentEl = aiMsgEl.querySelector('.msg-content');
    const cursor = aiMsgEl.querySelector('.cursor');

    // Thinking state
    let thinkEl = null;
    let thinkContentEl = null;
    let thinkStartTime = null;
    let fullThink = '';

    try {
      const resp = await fetch(chatServerUrl + '/sessions/' + chatSessionId + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, model: els.modelSelect.value || undefined })
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.detail || 'Chat server error');
      }

      // Stream the response
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // Parse SSE lines
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);

              if (parsed.think_start) {
                thinkStartTime = Date.now();
                fullThink = '';
                thinkEl = document.createElement('details');
                thinkEl.className = 'think-block streaming';
                thinkEl.open = true;
                const summary = document.createElement('summary');
                summary.innerHTML = '<span class="think-spinner"></span><span class="chevron">&#9654;</span> Thinking\u2026';
                thinkContentEl = document.createElement('div');
                thinkContentEl.className = 'think-content';
                thinkEl.appendChild(summary);
                thinkEl.appendChild(thinkContentEl);
                aiMsgEl.insertBefore(thinkEl, contentEl);
                scrollToBottom();

              } else if (parsed.think) {
                fullThink += parsed.think;
                if (thinkContentEl) {
                  thinkContentEl.textContent = fullThink;
                  thinkContentEl.scrollTop = thinkContentEl.scrollHeight;
                }
                scrollToBottom();

              } else if (parsed.think_end) {
                if (thinkEl) {
                  thinkEl.classList.remove('streaming');
                  const elapsed = thinkStartTime
                    ? Math.round((Date.now() - thinkStartTime) / 1000)
                    : 0;
                  const label = elapsed < 1 ? '<1s' : elapsed + 's';
                  const summary = thinkEl.querySelector('summary');
                  summary.innerHTML = '<span class="chevron">&#9654;</span> Thought for ' + label;
                  thinkEl.open = false;
                }

              } else if (parsed.token) {
                fullText += parsed.token;
                contentEl.innerHTML = renderMarkdown(fullText);
                scrollToBottom();

              } else if (parsed.error) {
                throw new Error(parsed.error);
              }
            } catch (parseErr) {
              if (parseErr.message && !parseErr.message.startsWith('Unexpected')) {
                throw parseErr;
              }
              // Not JSON, treat as raw text
              fullText += data;
              contentEl.innerHTML = renderMarkdown(fullText);
              scrollToBottom();
            }
          }
        }
      }

      // Finalize message
      aiMsgEl.classList.remove('streaming');
      if (cursor) cursor.remove();
      contentEl.innerHTML = renderMarkdown(fullText);

      // If thinking never ended (model didn't close tag), finalize it
      if (thinkEl && thinkEl.classList.contains('streaming')) {
        thinkEl.classList.remove('streaming');
        const elapsed = thinkStartTime
          ? Math.round((Date.now() - thinkStartTime) / 1000)
          : 0;
        const label = elapsed < 1 ? '<1s' : elapsed + 's';
        const summary = thinkEl.querySelector('summary');
        summary.innerHTML = '<span class="chevron">&#9654;</span> Thought for ' + label;
        thinkEl.open = false;
      }

      // Remove thinking block if it was empty
      if (thinkEl && !fullThink.trim()) {
        thinkEl.remove();
      }

      // Add action buttons (read aloud + copy)
      addMessageActions(aiMsgEl, fullText);
      saveTabSession();

    } catch (e) {
      aiMsgEl.classList.remove('streaming');
      if (cursor) cursor.remove();
      contentEl.textContent = 'Error: ' + e.message;
      contentEl.style.color = '#e74c3c';
      // Clean up thinking block on error
      if (thinkEl && thinkEl.classList.contains('streaming')) {
        thinkEl.classList.remove('streaming');
        const summary = thinkEl.querySelector('summary');
        summary.innerHTML = '<span class="chevron">&#9654;</span> Thinking (interrupted)';
        thinkEl.open = false;
      }
    } finally {
      isChatStreaming = false;
      els.sendBtn.disabled = false;
      els.chatInput.focus();
    }
  }

  function appendMessage(role, text, streaming) {
    if (els.chatWelcome.parentNode === els.chatMessages) {
      // Remove welcome message on first real message
      // (keep it if it's the page-loaded message)
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'msg ' + role;
    if (streaming) msgEl.classList.add('streaming');

    if (role === 'ai') {
      msgEl.innerHTML = '<div class="msg-content">' + escapeHtml(text) + '</div>'
        + (streaming ? '<span class="cursor"></span>' : '');
    } else {
      msgEl.textContent = text;
    }

    els.chatMessages.appendChild(msgEl);
    scrollToBottom();
    return msgEl;
  }

  function addMessageActions(msgEl, text) {
    if (!text || text.trim().length === 0) return;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'msg-actions';

    // Read aloud / stop button
    const readBtn = document.createElement('button');
    readBtn.className = 'msg-action-btn read-aloud-btn';
    readBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg> Read aloud';
    readBtn.addEventListener('click', () => handleInlineReadAloud(text, readBtn));

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn copy-btn';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy';
    copyBtn.addEventListener('click', () => copyMessageText(text, copyBtn));

    actionsDiv.appendChild(readBtn);
    actionsDiv.appendChild(copyBtn);
    msgEl.appendChild(actionsDiv);
  }

  // ─── Inline TTS (independent from page reader) ────────────────────

  async function handleInlineReadAloud(text, btn) {
    // If this button is already active, stop playback
    if (btn === inlinePlayer.activeBtn) {
      stopInlinePlayback();
      return;
    }

    // Stop any other inline playback (page TTS is independent)
    stopInlinePlayback();

    const stored = await getSettings();
    const voice = els.voice.value || stored.voice || 'af_heart';
    const speed = parseFloat(els.speed.value) || stored.speed || 1.0;
    const serverUrl = stored.serverUrl || DEFAULT_SETTINGS.serverUrl;

    // Process text for TTS
    let processed = TextProcessor.process(text);
    if (!processed || processed.trim().length === 0) return;

    const chunks = TextProcessor.chunkText(processed, stored.maxChunkSize || 500);
    if (chunks.length === 0) return;

    inlinePlayer.activeBtn = btn;
    inlinePlayer.chunks = chunks;
    inlinePlayer.totalChunks = chunks.length;
    inlinePlayer.currentChunk = 0;
    inlinePlayer.abortController = new AbortController();

    setInlineBtnState(btn, 'loading');
    playInlineChunk(0, voice, speed, serverUrl, btn);
  }

  async function playInlineChunk(index, voice, speed, serverUrl, btn) {
    if (index >= inlinePlayer.totalChunks) {
      resetInlineBtn(btn);
      inlinePlayer.activeBtn = null;
      return;
    }
    if (btn !== inlinePlayer.activeBtn) return; // stale

    inlinePlayer.currentChunk = index;

    try {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg, audio/wav, audio/*'
        },
        body: JSON.stringify({
          model: 'kokoro',
          voice: voice,
          input: inlinePlayer.chunks[index],
          speed: speed,
          stream: false,
          response_format: 'mp3'
        }),
        signal: inlinePlayer.abortController.signal
      });

      if (!resp.ok) throw new Error('TTS error (' + resp.status + ')');

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      inlinePlayer.audio = audio;

      audio.onplay = () => setInlineBtnState(btn, 'playing');
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (btn !== inlinePlayer.activeBtn) return;
        const next = index + 1;
        if (next < inlinePlayer.totalChunks) {
          setInlineBtnState(btn, 'loading');
          playInlineChunk(next, voice, speed, serverUrl, btn);
        } else {
          resetInlineBtn(btn);
          inlinePlayer.activeBtn = null;
        }
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        showError('Audio playback failed');
        resetInlineBtn(btn);
        inlinePlayer.activeBtn = null;
      };

      audio.play().catch(err => {
        showError('Could not play audio');
        resetInlineBtn(btn);
        inlinePlayer.activeBtn = null;
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      showError('TTS failed: ' + err.message);
      resetInlineBtn(btn);
      inlinePlayer.activeBtn = null;
    }
  }

  function stopInlinePlayback() {
    if (inlinePlayer.abortController) {
      inlinePlayer.abortController.abort();
      inlinePlayer.abortController = null;
    }
    if (inlinePlayer.audio) {
      inlinePlayer.audio.pause();
      inlinePlayer.audio.src = '';
      inlinePlayer.audio = null;
    }
    if (inlinePlayer.activeBtn) {
      resetInlineBtn(inlinePlayer.activeBtn);
      inlinePlayer.activeBtn = null;
    }
    inlinePlayer.chunks = [];
    inlinePlayer.currentChunk = -1;
    inlinePlayer.totalChunks = 0;
  }

  function setInlineBtnState(btn, state) {
    if (state === 'loading') {
      btn.innerHTML = '<span class="inline-spinner"></span> Loading\u2026';
      btn.classList.add('loading');
      btn.classList.remove('playing');
    } else if (state === 'playing') {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg> Stop';
      btn.classList.add('playing');
      btn.classList.remove('loading');
    }
  }

  function resetInlineBtn(btn) {
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg> Read aloud';
    btn.classList.remove('playing', 'loading');
  }

  async function copyMessageText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.innerHTML;
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('copied');
      }, 1500);
    } catch (_) {
      showError('Failed to copy text');
    }
  }

  function scrollToBottom() {
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function autoResizeInput() {
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 80) + 'px';
  }

  // ─── TTS Event Handlers ──────────────────────────────────────────

  function setupTTSListeners() {
    els.playBtn.addEventListener('click', async () => {
      console.log('[play] clicked');
      clearError();
      console.log('[play] getting state…');
      const stateInfo = await audioPlayer.getState();
      console.log('[play] state:', stateInfo.state);
      if (stateInfo.state === 'paused') {
        audioPlayer.resume();
        updateUI('playing', stateInfo.chunkIndex, stateInfo.totalChunks);
        startSeekUpdates();
        return;
      }
      console.log('[play] getting settings…');
      const stored = await getSettings();
      const settings = {
        ...stored,
        voice: els.voice.value,
        speed: parseFloat(els.speed.value)
      };
      console.log('[play] saving voice/speed…');
      await saveVoiceAndSpeed();
      console.log('[play] calling startReading…');
      updateUI('loading', 0, 0);
      audioPlayer.startReading(settings);
      console.log('[play] done, seek updates started');
      startSeekUpdates();
    });

    els.pauseBtn.addEventListener('click', () => audioPlayer.pause());

    els.stopBtn.addEventListener('click', () => {
      audioPlayer.stop();
      updateUI('stopped', -1, 0);
      stopSeekUpdates();
    });

    els.prevBtn.addEventListener('click', () => audioPlayer.skipPrev());
    els.nextBtn.addEventListener('click', () => audioPlayer.skipNext());

    els.seekBar.addEventListener('mousedown', () => els.seekBar.classList.add('seeking'));
    els.seekBar.addEventListener('input', () => {
      els.currentTime.textContent = formatTime(parseFloat(els.seekBar.value));
    });
    els.seekBar.addEventListener('change', async () => {
      await audioPlayer.seek(parseFloat(els.seekBar.value));
      els.seekBar.classList.remove('seeking');
    });

    els.speed.addEventListener('input', () => {
      els.speedVal.textContent = parseFloat(els.speed.value).toFixed(1) + 'x';
    });
    els.speed.addEventListener('change', saveVoiceAndSpeed);
    els.voice.addEventListener('change', saveVoiceAndSpeed);
    els.refreshVoicesBtn.addEventListener('click', () => loadVoices(true));

    els.readPdfBtn.addEventListener('click', async () => {
      clearError();
      const url = els.readPdfBtn.dataset.pdfUrl;
      if (!url) { showError('No PDF URL found'); return; }
      const stored = await getSettings();
      const settings = { ...stored, voice: els.voice.value, speed: parseFloat(els.speed.value) };
      const pageStart = parseInt(els.pdfPageStart.value) || 1;
      const pageEnd = els.pdfPageEnd.value ? parseInt(els.pdfPageEnd.value) : null;
      await saveVoiceAndSpeed();
      updateUI('loading', 0, 0);
      audioPlayer.readPdf(url, pageStart, pageEnd, settings);
      startSeekUpdates();
    });

    els.settingsLink.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  // ─── Chat Event Handlers ──────────────────────────────────────────

  function setupChatListeners() {
    els.sendBtn.addEventListener('click', sendChatMessage);

    els.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    els.chatInput.addEventListener('input', autoResizeInput);

    els.modelSelect.addEventListener('change', () => {
      chrome.storage.local.set({ chatModel: els.modelSelect.value });
    });

    els.newChatBtn.addEventListener('click', () => {
      resetChat();
      checkChatHealth().then(healthy => {
        if (healthy) initChatSession();
      });
    });
  }

  function resetChat() {
    chatSessionId = null;
    isChatStreaming = false;
    els.chatMessages.innerHTML = '<div class="msg system" id="chatWelcome">Loading page context\u2026</div>';
    els.chatWelcome = $('chatWelcome');
    els.sendBtn.disabled = true;
    if (currentTabId) tabSessions.delete(currentTabId);
  }

  // ─── Message Listener ─────────────────────────────────────────────

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      switch (message.type) {
        case 'playerStateUpdate':
          updateUI(message.state, message.chunkIndex, message.totalChunks);
          if (message.state === 'playing') startSeekUpdates();
          else if (message.state === 'stopped') stopSeekUpdates();
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

  // ─── State Sync ───────────────────────────────────────────────────

  async function syncState() {
    const stateInfo = await audioPlayer.getState();
    updateUI(stateInfo.state, stateInfo.chunkIndex, stateInfo.totalChunks);
    if (stateInfo.state === 'playing' || stateInfo.state === 'paused') {
      startSeekUpdates();
    }
  }

  // ─── Keep-alive Port ───────────────────────────────────────────────
  // A persistent port prevents the MV3 service worker from going dormant.
  // Without this, the worker sleeps after ~30s of idle and messages are lost.

  function keepBackgroundAlive() {
    try {
      const port = chrome.runtime.connect({ name: 'keepalive' });
      port.onDisconnect.addListener(() => {
        // Service worker was terminated — reset AudioPlayer so init() re-creates offscreen
        if (audioPlayer) audioPlayer.isInitialized = false;
        setTimeout(keepBackgroundAlive, 1000);
      });
    } catch (e) {
      setTimeout(keepBackgroundAlive, 1000);
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    initEls();
    keepBackgroundAlive();

    audioPlayer = new AudioPlayer();
    await audioPlayer.init();

    // Load settings
    const settings = await getSettings();
    els.speed.value = settings.speed || 1.0;
    els.speedVal.textContent = (settings.speed || 1.0).toFixed(1) + 'x';
    if (settings.voice) els.voice.value = settings.voice;

    // Load chat server URL from settings
    chatServerUrl = settings.chatServerUrl || 'http://localhost:8882';

    // Track current tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) currentTabId = tabs[0].id;

    setupTTSListeners();
    setupChatListeners();
    setupMessageListener();

    // Run init tasks in parallel
    syncState();
    loadVoices(false);
    checkForPdf();
    checkServerHealth();
    checkChatHealth().then(healthy => {
      if (healthy) {
        loadModels();
        initChatSession();
      }
    });
  });

  // Save/restore chat when switching tabs
  chrome.tabs.onActivated.addListener((activeInfo) => {
    saveTabSession();
    currentTabId = activeInfo.tabId;

    if (restoreTabSession(activeInfo.tabId)) {
      // Restored previous chat for this tab
      checkForPdf();
      return;
    }

    // No saved session — init fresh
    chatSessionId = null;
    els.chatMessages.innerHTML = '<div class="msg system" id="chatWelcome">Open a page and start chatting about its content.</div>';
    els.chatWelcome = $('chatWelcome');
    els.sendBtn.disabled = true;
    checkForPdf();
    checkChatHealth().then(healthy => {
      if (healthy) initChatSession();
    });
  });

  // Clean up closed tabs
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabSessions.delete(tabId);
  });

})();
