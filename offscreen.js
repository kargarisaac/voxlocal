/**
 * Offscreen document for Local TTS Reader.
 * Handles audio playback queue and PDF text extraction.
 * MV3 service workers cannot play audio, so this offscreen doc handles it.
 */
(function () {
  'use strict';

  let audioElement = null;
  let audioContext = null;
  let audioSource = null;
  let sourceConnected = false;

  // Audio chunk queue for gapless playback
  let audioQueue = [];       // Array of { blob, chunkIndex }
  let isPlaying = false;
  let currentChunkIndex = -1;

  // ─── Audio Initialization ─────────────────────────────────────────

  function initAudio() {
    if (!audioElement) {
      audioElement = document.createElement('audio');
      audioElement.id = 'ttsAudio';
      document.body.appendChild(audioElement);
    }

    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  function connectSource() {
    if (sourceConnected || !audioElement || !audioContext) return;
    try {
      if (audioSource) {
        try { audioSource.disconnect(); } catch (_) {}
      }
      audioSource = audioContext.createMediaElementSource(audioElement);
      audioSource.connect(audioContext.destination);
      sourceConnected = true;
    } catch (e) {
      console.error('Error connecting audio source:', e);
    }
  }

  // ─── Chunk Playback ───────────────────────────────────────────────

  function playChunk(audioDataArray, mimeType, chunkIndex) {
    initAudio();

    const uint8 = new Uint8Array(audioDataArray);
    const blob = new Blob([uint8], { type: mimeType || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);

    currentChunkIndex = chunkIndex;

    // Null out old handlers BEFORE changing src to prevent stale events
    audioElement.onplay = null;
    audioElement.onpause = null;
    audioElement.onended = null;
    audioElement.ontimeupdate = null;
    audioElement.onerror = null;

    // Revoke previous URL
    if (audioElement.src && audioElement.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioElement.src);
    }

    audioElement.src = url;

    audioElement.onplay = () => {
      isPlaying = true;
      connectSource();
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'playing' });
    };

    audioElement.onpause = () => {
      isPlaying = false;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'paused' });
    };

    audioElement.onended = () => {
      isPlaying = false;
      // Check if there's a queued chunk
      if (audioQueue.length > 0) {
        const next = audioQueue.shift();
        playChunkFromBlob(next.blob, next.mimeType, next.chunkIndex);
      } else {
        chrome.runtime.sendMessage({ type: 'chunkPlaybackEnded', chunkIndex: currentChunkIndex });
      }
    };

    audioElement.ontimeupdate = () => {
      chrome.runtime.sendMessage({
        type: 'audioTimeUpdate',
        timeInfo: {
          currentTime: audioElement.currentTime,
          duration: audioElement.duration || 0,
          chunkIndex: currentChunkIndex
        }
      });
    };

    audioElement.onerror = (e) => {
      console.error('Audio playback error:', e);
      chrome.runtime.sendMessage({
        type: 'streamError',
        error: 'Audio playback failed'
      });
    };

    // Resume AudioContext if suspended (autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    audioElement.play().catch(err => {
      console.error('Play error:', err);
      chrome.runtime.sendMessage({ type: 'streamError', error: err.message });
    });
  }

  function playChunkFromBlob(blob, mimeType, chunkIndex) {
    initAudio();

    currentChunkIndex = chunkIndex;
    const url = URL.createObjectURL(blob);

    if (audioElement.src && audioElement.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioElement.src);
    }

    audioElement.src = url;

    // Re-register onended for the new chunk so it fires with the correct index
    audioElement.onended = () => {
      isPlaying = false;
      if (audioQueue.length > 0) {
        const next = audioQueue.shift();
        playChunkFromBlob(next.blob, next.mimeType, next.chunkIndex);
      } else {
        chrome.runtime.sendMessage({ type: 'chunkPlaybackEnded', chunkIndex: currentChunkIndex });
      }
    };

    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }

    audioElement.play().catch(err => {
      console.error('Play error:', err);
      chrome.runtime.sendMessage({ type: 'streamError', error: err.message });
    });
  }

  /**
   * Queue a chunk for gapless playback.
   * If nothing is currently playing, play immediately.
   */
  function queueChunk(audioDataArray, mimeType, chunkIndex) {
    const uint8 = new Uint8Array(audioDataArray);
    const blob = new Blob([uint8], { type: mimeType || 'audio/mpeg' });

    if (!isPlaying && audioQueue.length === 0 &&
        (!audioElement || audioElement.paused || audioElement.ended)) {
      // Nothing playing, start immediately
      playChunk(audioDataArray, mimeType, chunkIndex);
    } else {
      // Queue for gapless transition
      audioQueue.push({ blob, mimeType, chunkIndex });
    }
  }

  // ─── Playback Controls ────────────────────────────────────────────

  function resumePlayback() {
    if (audioElement && audioElement.paused) {
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
      }
      audioElement.play().catch(console.error);
    }
  }

  function pausePlayback() {
    if (audioElement && !audioElement.paused) {
      audioElement.pause();
    }
  }

  function stopPlayback() {
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
      if (audioElement.src && audioElement.src.startsWith('blob:')) {
        URL.revokeObjectURL(audioElement.src);
      }
      audioElement.src = '';
    }
    audioQueue = [];
    isPlaying = false;
    currentChunkIndex = -1;
    chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
  }

  function seekTo(time) {
    if (audioElement) {
      try {
        audioElement.currentTime = time;
        return true;
      } catch (e) {
        console.error('Seek error:', e);
      }
    }
    return false;
  }

  function getState() {
    if (!audioElement) return 'stopped';
    if (audioElement.paused) {
      return (audioElement.currentTime > 0 && audioElement.currentTime < audioElement.duration)
        ? 'paused' : 'stopped';
    }
    return 'playing';
  }

  function getTimeInfo() {
    if (!audioElement) return null;
    return {
      currentTime: audioElement.currentTime || 0,
      duration: audioElement.duration || 0,
      chunkIndex: currentChunkIndex
    };
  }

  // ─── PDF Extraction ───────────────────────────────────────────────

  async function extractPdfText(pdfData, pageStart, pageEnd) {
    // pdfExtractor is defined in utils/pdfExtractor.js
    if (typeof pdfExtractor === 'undefined') {
      throw new Error('PDF extractor not loaded');
    }
    return await pdfExtractor.extractText(pdfData, pageStart, pageEnd);
  }

  // ─── Message Handler ──────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only handle messages targeted to offscreen (or without a target for backward compat)
    if (message.target && message.target !== 'offscreen') return false;

    switch (message.type) {
      case 'playAudioChunk':
        playChunk(message.audioData, message.mimeType, message.chunkIndex);
        sendResponse({ ok: true });
        return false;

      case 'queueAudioChunk':
        queueChunk(message.audioData, message.mimeType, message.chunkIndex);
        sendResponse({ ok: true });
        return false;

      case 'play':
        resumePlayback();
        return false;

      case 'pause':
        pausePlayback();
        return false;

      case 'stop':
        stopPlayback();
        return false;

      case 'seek': {
        const success = seekTo(message.time);
        sendResponse({ success });
        return false;
      }

      case 'getState':
        sendResponse({ state: getState() });
        return false;

      case 'getTimeInfo':
        sendResponse({ timeInfo: getTimeInfo() });
        return false;

      case 'clearQueue':
        audioQueue = [];
        sendResponse({ ok: true });
        return false;

      case 'extractPdfText': {
        // Convert plain array back to Uint8Array for PDF.js
        const pdfData = new Uint8Array(message.pdfData);
        extractPdfText(pdfData, message.pageStart, message.pageEnd)
          .then(result => sendResponse({ result }))
          .catch(err => sendResponse({ error: err.message }));
        return true; // async
      }

      default:
        return false;
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    initAudio();
  });

})();
