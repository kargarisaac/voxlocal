/**
 * Options page script for Local TTS Reader.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {};

  function initEls() {
    els.backend       = $('backend');
    els.serverUrl     = $('serverUrl');
    els.defaultVoice  = $('defaultVoice');
    els.defaultSpeed  = $('defaultSpeed');
    els.defaultSpeedVal = $('defaultSpeedVal');
    els.autoReaderMode = $('autoReaderMode');
    els.preprocessText = $('preprocessText');
    els.maxChunkSize  = $('maxChunkSize');
    els.maxChunkSizeVal = $('maxChunkSizeVal');
    els.saveBtn       = $('saveBtn');
    els.saveMsg       = $('saveMsg');
  }

  function loadSettings() {
    chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {
      els.backend.value = settings.backend || 'kokoro';
      els.serverUrl.value = settings.serverUrl || BACKENDS[settings.backend || 'kokoro'].speechUrl;
      els.defaultVoice.value = settings.voice || 'af_heart';
      els.defaultSpeed.value = settings.speed || 1.0;
      els.defaultSpeedVal.textContent = (settings.speed || 1.0).toFixed(1) + 'x';
      els.autoReaderMode.checked = settings.autoReaderMode !== false;
      els.preprocessText.checked = settings.preprocessText !== false;
      els.maxChunkSize.value = settings.maxChunkSize || 500;
      els.maxChunkSizeVal.textContent = settings.maxChunkSize || 500;
    });
  }

  function saveSettings() {
    const backendKey = els.backend.value;

    chrome.storage.local.set({
      backend: backendKey,
      serverUrl: els.serverUrl.value,
      voice: els.defaultVoice.value,
      speed: parseFloat(els.defaultSpeed.value),
      autoReaderMode: els.autoReaderMode.checked,
      preprocessText: els.preprocessText.checked,
      maxChunkSize: parseInt(els.maxChunkSize.value)
    }, () => {
      els.saveMsg.classList.add('visible');
      setTimeout(() => els.saveMsg.classList.remove('visible'), 2000);
    });
  }

  function setupListeners() {
    // Backend dropdown changes server URL
    els.backend.addEventListener('change', () => {
      const key = els.backend.value;
      const backend = BACKENDS[key];
      if (backend) {
        els.serverUrl.value = backend.speechUrl;
      }
    });

    // Speed slider
    els.defaultSpeed.addEventListener('input', () => {
      els.defaultSpeedVal.textContent = parseFloat(els.defaultSpeed.value).toFixed(1) + 'x';
    });

    // Chunk size slider
    els.maxChunkSize.addEventListener('input', () => {
      els.maxChunkSizeVal.textContent = els.maxChunkSize.value;
    });

    // Save button
    els.saveBtn.addEventListener('click', saveSettings);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initEls();
    loadSettings();
    setupListeners();
  });

})();
