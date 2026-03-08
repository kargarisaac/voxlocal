/**
 * Content script for Voxlocal.
 * Handles text extraction (Readability, X/Twitter, selection, PDF detection).
 */
(function () {
  'use strict';

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

    const url = window.location.pathname;
    const isSingleTweetPage = /^\/[^/]+\/status\/\d+/.test(url);

    let texts = [];
    if (isSingleTweetPage) {
      const mainTweet = tweetElements[0];
      texts.push(mainTweet.innerText);
      for (let i = 1; i < tweetElements.length; i++) {
        texts.push(tweetElements[i].innerText);
      }
    } else {
      tweetElements.forEach(el => {
        texts.push(el.innerText);
      });
    }

    const combined = texts.join('. ');
    return combined.replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract article content using Mozilla Readability.
   */
  function extractWithReadability() {
    try {
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
    if (url.match(/\.pdf(\?|#|$)/i)) return url;
    if (url.includes('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) return url;
    if (/\/pdf\//i.test(url) || /\/pdf$/i.test(url)) {
      const embed = document.querySelector('embed[type="application/pdf"]');
      if (embed) return embed.src || url;
      if (document.body && document.body.children.length <= 3) {
        const embedAny = document.querySelector('embed, object[type="application/pdf"]');
        if (embedAny) return url;
      }
      return url;
    }
    const pdfEmbed = document.querySelector('embed[type="application/pdf"]');
    if (pdfEmbed) return pdfEmbed.src || url;
    return null;
  }

  /**
   * Extract text from the page.
   * Priority: selected text > Twitter > Readability > body innerText
   */
  function extractText(useReaderMode) {
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';
    if (selectedText) {
      return { text: selectedText, source: 'selection' };
    }

    const url = window.location.href;
    const pdfDetected = isPdfPage(url);
    if (pdfDetected) {
      return { text: '', source: 'pdf', pdfUrl: pdfDetected };
    }

    if (isTwitterPage()) {
      const tweetText = extractTwitterText();
      if (tweetText) {
        return { text: tweetText, source: 'twitter' };
      }
    }

    if (useReaderMode) {
      const articleText = extractWithReadability();
      if (articleText) {
        return { text: articleText, source: 'readability' };
      }
    }

    const bodyText = document.body.innerText || '';
    return { text: bodyText.trim(), source: 'body' };
  }

  // ─── Message Handling ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'extractText') {
      const result = extractText(message.useReaderMode !== false);
      sendResponse(result);
      return false;
    }
  });

})();
