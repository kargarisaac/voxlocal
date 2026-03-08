/**
 * Text processor for TTS - handles cleaning, sentence splitting, and chunking.
 */
class TextProcessor {
  /**
   * Process and clean text for TTS.
   * @param {string} text - Raw text
   * @returns {string} - Cleaned text
   */
  static process(text) {
    if (!text) return '';

    let t = text;

    // Remove markdown headers
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '$1');

    // Remove markdown bold/italic
    t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
    t = t.replace(/(\*|_)(.*?)\1/g, '$2');

    // Remove markdown code blocks
    t = t.replace(/```[\s\S]*?```/g, 'code block omitted.');
    t = t.replace(/`([^`]+)`/g, '$1');

    // Remove markdown links but keep text
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

    // Remove markdown list markers
    t = t.replace(/^[\s]*[-*+]\s+/gm, '');
    t = t.replace(/^\s*\d+\.\s+/gm, '');

    // Remove HTML tags
    t = t.replace(/<[^>]*>/g, '');

    // Process URLs into readable form
    t = this.processUrls(t);

    // Replace common symbols with words
    t = t.replace(/&/g, ' and ');
    t = t.replace(/\$/g, ' dollars ');
    t = t.replace(/%/g, ' percent ');

    // Remove special characters that don't read well
    t = t.replace(/[|*~`^]/g, ' ');

    // Replace multiple dots with single period
    t = t.replace(/\.{2,}/g, '.');

    // Collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();

    return t;
  }

  /**
   * Process URLs in text to readable form.
   */
  static processUrls(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, (url) => {
      try {
        const urlObj = new URL(url);
        let domain = urlObj.hostname.replace(/^www\./, '');
        const parts = domain.split('.');
        const name = parts.length > 1 ? parts[parts.length - 2] : parts[0];
        const tld = parts[parts.length - 1];
        return `[${name} dot ${tld} link]`;
      } catch {
        return '[web link]';
      }
    });
  }

  /**
   * Remove t.co links from text (Twitter shortened URLs).
   */
  static stripTcoLinks(text) {
    return text.replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Split text into sentence-level chunks for streaming TTS.
   * Each chunk is at most maxSize characters, split on sentence boundaries.
   * @param {string} text - Cleaned text
   * @param {number} maxSize - Maximum chunk size (default 500)
   * @returns {string[]} - Array of text chunks
   */
  static chunkText(text, maxSize = 500) {
    if (!text) return [];
    if (text.length <= maxSize) return [text];

    const sentences = this.splitSentences(text);
    const chunks = [];
    let current = '';

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      // If a single sentence exceeds maxSize, split it further
      if (trimmed.length > maxSize) {
        if (current) {
          chunks.push(current.trim());
          current = '';
        }
        const subChunks = this.splitLongSentence(trimmed, maxSize);
        chunks.push(...subChunks);
        continue;
      }

      // Would adding this sentence exceed the limit?
      if (current.length + trimmed.length + 1 > maxSize) {
        if (current) {
          chunks.push(current.trim());
        }
        current = trimmed;
      } else {
        current = current ? current + ' ' + trimmed : trimmed;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks.filter(c => c.length > 0);
  }

  /**
   * Split text into sentences.
   * Handles common abbreviations to avoid false splits.
   */
  static splitSentences(text) {
    const abbrevs = [
      'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr',
      'vs', 'etc', 'approx', 'dept', 'est', 'vol',
      'Inc', 'Ltd', 'Corp', 'Co', 'St', 'Ave', 'Blvd',
      'Gen', 'Gov', 'Sgt', 'Cpl', 'Pvt', 'Capt',
      'Fig', 'eq', 'ref', 'no', 'No'
    ];

    let processed = text;
    for (const abbr of abbrevs) {
      const regex = new RegExp('\\b' + abbr + '\\.', 'g');
      processed = processed.replace(regex, abbr + '\u0000');
    }

    // Protect decimal numbers
    processed = processed.replace(/(\d)\.(\d)/g, '$1\u0001$2');

    // Split on sentence-ending punctuation followed by space or end
    const parts = processed.split(/(?<=[.!?])\s+/);

    return parts.map(p => p.replace(/\u0000/g, '.').replace(/\u0001/g, '.'));
  }

  /**
   * Split a long sentence that exceeds maxSize into smaller pieces.
   */
  static splitLongSentence(sentence, maxSize) {
    const chunks = [];
    const clauseBreaks = sentence.split(/(?<=[,;])\s+|(?<=\band\b|\bbut\b|\bor\b)\s+/);
    let current = '';

    for (const part of clauseBreaks) {
      if (current.length + part.length + 1 > maxSize) {
        if (current) chunks.push(current.trim());
        if (part.length > maxSize) {
          const words = part.split(/\s+/);
          current = '';
          for (const word of words) {
            if (current.length + word.length + 1 > maxSize) {
              if (current) chunks.push(current.trim());
              current = word;
            } else {
              current = current ? current + ' ' + word : word;
            }
          }
        } else {
          current = part;
        }
      } else {
        current = current ? current + ' ' + part : part;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks;
  }
}

// Make available globally
if (typeof window !== 'undefined') {
  window.TextProcessor = TextProcessor;
} else if (typeof self !== 'undefined') {
  self.TextProcessor = TextProcessor;
}
