/**
 * AudioPlayer - Side-panel abstraction for audio playback control.
 * Communicates with the background service worker.
 */
class AudioPlayer {
  constructor() {
    this.isInitialized = false;
  }

  async init() {
    if (!this.isInitialized) {
      await chrome.runtime.sendMessage({ type: 'setupOffscreen' });
      this.isInitialized = true;
    }
  }

  /**
   * Start reading text with given settings.
   */
  async startReading(settings) {
    await this.init();
    return chrome.runtime.sendMessage({
      type: 'startReading',
      settings: settings
    });
  }

  /**
   * Start reading a PDF.
   */
  async readPdf(url, pageStart, pageEnd, settings) {
    await this.init();
    return chrome.runtime.sendMessage({
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
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'seekInChunk', time: time },
        (response) => resolve(response && response.success)
      );
    });
  }

  async getState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getPlayerState' }, (response) => {
        resolve(response || { state: 'stopped', chunkIndex: 0, totalChunks: 0 });
      });
    });
  }

  async getTimeInfo() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getTimeInfo' }, (response) => {
        resolve(response ? response.timeInfo : null);
      });
    });
  }

  async fetchVoices() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'fetchVoices' }, (response) => {
        resolve(response ? response.voices : []);
      });
    });
  }

  async checkHealth() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'checkHealth' }, (response) => {
        resolve(response || { healthy: false });
      });
    });
  }
}

if (typeof window !== 'undefined') {
  window.AudioPlayer = AudioPlayer;
}
