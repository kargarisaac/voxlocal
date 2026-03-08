const DEFAULT_SETTINGS = {
  backend: 'kokoro',
  serverUrl: 'http://localhost:8880/v1/audio/speech',
  voice: 'af_heart',
  speed: 1.0,
  preprocessText: true,
  autoReaderMode: true,
  maxChunkSize: 500,
  chatServerUrl: 'http://localhost:8882'
};

const BACKENDS = {
  kokoro: {
    name: 'Kokoro TTS',
    speechUrl: 'http://localhost:8880/v1/audio/speech',
    voicesUrl: 'http://localhost:8880/v1/audio/voices',
    healthUrl: 'http://localhost:8880/health'
  },
  kittentts: {
    name: 'KittenTTS',
    speechUrl: 'http://localhost:8881/v1/audio/speech',
    voicesUrl: 'http://localhost:8881/v1/audio/voices',
    healthUrl: 'http://localhost:8881/health'
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_SETTINGS, BACKENDS };
} else if (typeof self !== 'undefined') {
  self.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  self.BACKENDS = BACKENDS;
}
