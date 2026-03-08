/**
 * AudioPlayer - Side-panel abstraction for audio playback control.
 * Communicates with the background service worker.
 */
class AudioPlayer {
  constructor() {
    this.isInitialized = false;
  }

  /**
   * Send a message to background with a timeout.
   * Prevents the UI from hanging if the service worker is dormant or unresponsive.
   */
  _send(msg, fallback, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn('AudioPlayer: timeout waiting for', msg.type);
        resolve(fallback);
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            console.warn('AudioPlayer:', msg.type, chrome.runtime.lastError.message);
            resolve(fallback);
          } else {
            resolve(response === undefined ? fallback : response);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        console.warn('AudioPlayer: sendMessage error for', msg.type, e);
        resolve(fallback);
      }
    });
  }

  async init() {
    if (!this.isInitialized) {
      await this._send({ type: 'setupOffscreen' }, { success: false }, 5000);
      this.isInitialized = true;
    }
  }

  /**
   * Start reading the current page aloud.
   */
  async startReading(settings) {
    await this.init();
    chrome.runtime.sendMessage({ type: 'startReading', settings: settings });
  }

  /**
   * Read arbitrary text aloud (e.g. AI chat responses).
   */
  async readText(text, settings) {
    await this.init();
    chrome.runtime.sendMessage({ type: 'readText', text: text, settings: settings });
  }

  /**
   * Start reading a PDF.
   */
  async readPdf(url, pageStart, pageEnd, settings) {
    await this.init();
    chrome.runtime.sendMessage({
      type: 'readPdf',
      url: url,
      pageStart: pageStart,
      pageEnd: pageEnd,
      settings: settings
    });
  }

  resume() {
    chrome.runtime.sendMessage({ type: 'controlAudio', action: 'play' });
  }

  pause() {
    chrome.runtime.sendMessage({ type: 'controlAudio', action: 'pause' });
  }

  stop() {
    chrome.runtime.sendMessage({ type: 'controlAudio', action: 'stop' });
  }

  skipNext() {
    chrome.runtime.sendMessage({ type: 'skipChunk', direction: 'next' });
  }

  skipPrev() {
    chrome.runtime.sendMessage({ type: 'skipChunk', direction: 'prev' });
  }

  async seek(time) {
    return this._send(
      { type: 'seekInChunk', time: time },
      { success: false }
    ).then(r => r && r.success);
  }

  async getState() {
    return this._send(
      { type: 'getPlayerState' },
      { state: 'stopped', chunkIndex: 0, totalChunks: 0 }
    );
  }

  async getTimeInfo() {
    return this._send(
      { type: 'getTimeInfo' },
      { timeInfo: null }
    ).then(r => r ? r.timeInfo : null);
  }

  async fetchVoices() {
    return this._send(
      { type: 'fetchVoices' },
      { voices: [] },
      8000
    ).then(r => r ? r.voices : []);
  }

  async checkHealth() {
    return this._send(
      { type: 'checkHealth' },
      { healthy: false }
    );
  }
}

if (typeof window !== 'undefined') {
  window.AudioPlayer = AudioPlayer;
}
