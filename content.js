/**
 * Content script for Local TTS Reader.
 * Handles text extraction (Readability, X/Twitter, selection) and floating widget.
 */
(function () {
  'use strict';

  // ─── Floating Widget ────────────────────────────────────────────────

  let widgetHost = null;
  let widgetShadow = null;

  function createWidget() {
    if (widgetHost) return;

    widgetHost = document.createElement('div');
    widgetHost.id = 'local-tts-widget-host';
    widgetShadow = widgetHost.attachShadow({ mode: 'closed' });

    widgetShadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .widget {
          background: #1a1a2e;
          border: 1px solid #0f3460;
          border-radius: 12px;
          padding: 8px 14px;
          display: flex;
          align-items: center;
          gap: 10px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          font-size: 13px;
          color: #e6e6e6;
          user-select: none;
          opacity: 0.92;
          transition: opacity 0.2s;
        }
        .widget:hover { opacity: 1; }
        .widget.hidden { display: none; }
        .btn {
          background: #0f3460;
          border: none;
          color: #e6e6e6;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
          padding: 0;
        }
        .btn:hover { background: #e94560; }
        .btn.active { background: #e94560; }
        .progress {
          font-size: 11px;
          color: #aaa;
          min-width: 60px;
          text-align: center;
        }
        .close-btn {
          background: none;
          border: none;
          color: #666;
          cursor: pointer;
          font-size: 14px;
          padding: 0 0 0 4px;
          line-height: 1;
        }
        .close-btn:hover { color: #e94560; }
        .speaker-icon {
          display: inline-block;
          width: 16px;
          height: 16px;
        }
        .speaker-icon.playing {
          animation: pulse 1s ease-in-out infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .state-label {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .state-label.playing { color: #2ecc71; }
        .state-label.paused  { color: #f39c12; }
        .state-label.loading { color: #3498db; }
        .skip-btn {
          width: 24px;
          height: 24px;
          border-radius: 4px;
          font-size: 10px;
        }
        .skip-btn svg {
          width: 14px;
          height: 14px;
          fill: currentColor;
        }
        .skip-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
      </style>
      <div class="widget hidden" id="widget">
        <svg class="speaker-icon" id="speaker-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
        </svg>
        <span class="state-label" id="state-label">stopped</span>
        <button class="btn skip-btn" id="w-prev" title="Previous chunk" disabled>
          <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" transform="scale(-1,1) translate(-24,0)"/></svg>
        </button>
        <button class="btn" id="w-play" title="Play">&#9654;</button>
        <button class="btn" id="w-pause" title="Pause">&#10074;&#10074;</button>
        <button class="btn" id="w-stop" title="Stop">&#9724;</button>
        <button class="btn skip-btn" id="w-next" title="Next chunk" disabled>
          <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>
        <span class="progress" id="w-progress"></span>
        <button class="close-btn" id="w-close" title="Dismiss">&times;</button>
      </div>
    `;

    document.body.appendChild(widgetHost);

    // Widget button handlers
    const shadow = widgetShadow;
    shadow.getElementById('w-prev').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'skipChunk', direction: 'prev' });
    });
    shadow.getElementById('w-play').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'controlAudio', action: 'play' });
    });
    shadow.getElementById('w-pause').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'controlAudio', action: 'pause' });
    });
    shadow.getElementById('w-stop').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'controlAudio', action: 'stop' });
    });
    shadow.getElementById('w-next').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'skipChunk', direction: 'next' });
    });
    shadow.getElementById('w-close').addEventListener('click', () => {
      hideWidget();
    });
  }

  function showWidget(state, chunkIndex, totalChunks) {
    createWidget();
    const widget = widgetShadow.getElementById('widget');
    widget.classList.remove('hidden');
    updateWidget(state, chunkIndex, totalChunks);
  }

  function hideWidget() {
    if (widgetShadow) {
      const widget = widgetShadow.getElementById('widget');
      if (widget) widget.classList.add('hidden');
    }
  }

  function updateWidget(state, chunkIndex, totalChunks) {
    if (!widgetShadow) return;

    const stateLabel = widgetShadow.getElementById('state-label');
    const progress = widgetShadow.getElementById('w-progress');
    const speakerIcon = widgetShadow.getElementById('speaker-icon');
    const playBtn = widgetShadow.getElementById('w-play');
    const pauseBtn = widgetShadow.getElementById('w-pause');
    const prevBtn = widgetShadow.getElementById('w-prev');
    const nextBtn = widgetShadow.getElementById('w-next');

    if (stateLabel) {
      stateLabel.textContent = state;
      stateLabel.className = 'state-label ' + state;
    }

    if (speakerIcon) {
      speakerIcon.classList.toggle('playing', state === 'playing');
    }

    if (progress && typeof chunkIndex === 'number' && typeof totalChunks === 'number') {
      progress.textContent = `${chunkIndex + 1} / ${totalChunks}`;
    }

    if (playBtn && pauseBtn) {
      playBtn.style.display = state === 'playing' ? 'none' : 'flex';
      pauseBtn.style.display = state === 'playing' ? 'flex' : 'none';
    }

    // Enable/disable skip buttons based on chunk position
    if (prevBtn) {
      prevBtn.disabled = (typeof chunkIndex !== 'number' || chunkIndex <= 0);
    }
    if (nextBtn) {
      nextBtn.disabled = (typeof chunkIndex !== 'number' || typeof totalChunks !== 'number' || chunkIndex >= totalChunks - 1);
    }
  }

  // ─── Text Extraction ────────────────────────────────────────────────

  /**
   * Check if the current page is X/Twitter.
   */
  function isTwitterPage() {
    const host = window.location.hostname;
    return host === 'x.com' || host === 'twitter.com' ||
           host === 'www.x.com' || host === 'www.twitter.com' ||
           host === 'mobile.x.com' || host === 'mobile.twitter.com';
  }

  /**
   * Extract tweet text from X/Twitter pages.
   */
  function extractTwitterText() {
    const tweetElements = document.querySelectorAll('[data-testid="tweetText"]');
    if (!tweetElements || tweetElements.length === 0) return null;

    // Check if this is a single tweet detail page or a thread
    // On a tweet detail page, the main tweet is the first one
    const url = window.location.pathname;
    const isSingleTweetPage = /^\/[^/]+\/status\/\d+/.test(url);

    let texts = [];
    if (isSingleTweetPage) {
      // Get all tweet texts (main tweet + thread replies by same author)
      // The first tweetText is always the main tweet
      const mainTweet = tweetElements[0];
      texts.push(mainTweet.innerText);

      // Check for thread continuation (same author's replies)
      for (let i = 1; i < tweetElements.length; i++) {
        texts.push(tweetElements[i].innerText);
      }
    } else {
      // Timeline view - read all visible tweets
      tweetElements.forEach(el => {
        texts.push(el.innerText);
      });
    }

    // Strip t.co links
    const combined = texts.join('. ');
    return combined.replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract article content using Mozilla Readability.
   */
  function extractWithReadability() {
    try {
      // Readability is loaded via content_scripts in manifest.json
      if (typeof Readability === 'undefined') {
        return null;
      }

      const documentClone = document.cloneNode(true);
      const reader = new Readability(documentClone);
      const article = reader.parse();

      if (article && article.textContent && article.textContent.trim().length > 100) {
        return article.textContent.trim();
      }
    } catch (e) {
      console.warn('Voxlocal: Readability extraction failed:', e);
    }
    return null;
  }

  /**
   * Detect if the current page is a PDF.
   * Returns the PDF URL if detected, or null.
   */
  function isPdfPage(url) {
    // 1. URL ends in .pdf (with optional query/hash)
    if (url.match(/\.pdf(\?|#|$)/i)) return url;

    // 2. Chrome's internal PDF viewer
    if (url.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) return url;

    // 3. URL path contains /pdf/ (arxiv, etc.) — check for PDF embed to confirm
    if (/\/pdf\//i.test(url) || /\/pdf$/i.test(url)) {
      // Verify by checking for Chrome's PDF viewer embed element
      const embed = document.querySelector('embed[type="application/pdf"]');
      if (embed) return embed.src || url;
      // Also check if the body has minimal content (PDF viewer pages are sparse)
      if (document.body && document.body.children.length <= 3) {
        const embedAny = document.querySelector('embed, object[type="application/pdf"]');
        if (embedAny) return url;
      }
      // If the path clearly looks like a PDF endpoint, trust it
      return url;
    }

    // 4. Check for PDF viewer embed on any page
    const pdfEmbed = document.querySelector('embed[type="application/pdf"]');
    if (pdfEmbed) return pdfEmbed.src || url;

    return null;
  }

  /**
   * Extract text from the page.
   * Priority: selected text > Twitter > Readability > body innerText
   */
  function extractText(useReaderMode) {
    // 1. Check for selected text first
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';
    if (selectedText) {
      return { text: selectedText, source: 'selection' };
    }

    // 2. Check if this is a PDF page
    const url = window.location.href;
    const pdfDetected = isPdfPage(url);
    if (pdfDetected) {
      return { text: '', source: 'pdf', pdfUrl: pdfDetected };
    }

    // 3. X/Twitter specific extraction
    if (isTwitterPage()) {
      const tweetText = extractTwitterText();
      if (tweetText) {
        return { text: tweetText, source: 'twitter' };
      }
    }

    // 4. Readability extraction (if auto-reader mode enabled)
    if (useReaderMode) {
      const articleText = extractWithReadability();
      if (articleText) {
        return { text: articleText, source: 'readability' };
      }
    }

    // 5. Fallback to body innerText
    const bodyText = document.body.innerText || '';
    return { text: bodyText.trim(), source: 'body' };
  }

  // ─── Message Handling ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'extractText':
        const result = extractText(message.useReaderMode !== false);
        sendResponse(result);
        return false; // synchronous response

      case 'showWidget':
        showWidget(message.state, message.chunkIndex, message.totalChunks);
        sendResponse({ ok: true });
        return false;

      case 'updateWidget':
        updateWidget(message.state, message.chunkIndex, message.totalChunks);
        sendResponse({ ok: true });
        return false;

      case 'hideWidget':
        hideWidget();
        sendResponse({ ok: true });
        return false;
    }
  });

})();
