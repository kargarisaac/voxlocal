/**
 * PDF text extractor using PDF.js.
 * Runs inside the offscreen document which has DOM access for workers.
 */
class PdfExtractor {
  constructor() {
    this.pdfjsLib = null;
    this.loaded = false;
  }

  /**
   * Lazy-load PDF.js via dynamic import.
   */
  async ensureLoaded() {
    if (this.loaded) return;

    try {
      const pdfJsUrl = chrome.runtime.getURL('lib/pdf.min.mjs');
      this.pdfjsLib = await import(pdfJsUrl);

      const workerUrl = chrome.runtime.getURL('lib/pdf.worker.min.mjs');
      this.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

      this.loaded = true;
    } catch (e) {
      console.error('Failed to load PDF.js:', e);
      // Fallback: try without worker
      try {
        const pdfJsUrl = chrome.runtime.getURL('lib/pdf.min.mjs');
        this.pdfjsLib = await import(pdfJsUrl);
        this.pdfjsLib.GlobalWorkerOptions.workerSrc = '';
        this.loaded = true;
      } catch (e2) {
        throw new Error('Cannot load PDF.js library: ' + e2.message);
      }
    }
  }

  /**
   * Extract text from a PDF ArrayBuffer.
   * @param {ArrayBuffer} data - PDF file data
   * @param {number} pageStart - First page to extract (1-indexed, default 1)
   * @param {number} pageEnd - Last page to extract (default: all pages)
   * @returns {Promise<{pages: Array<{pageNum: number, text: string}>, totalPages: number}>}
   */
  async extractText(data, pageStart = 1, pageEnd = null) {
    await this.ensureLoaded();

    const loadingTask = this.pdfjsLib.getDocument({ data: data });
    const pdf = await loadingTask.promise;

    const totalPages = pdf.numPages;
    const start = Math.max(1, pageStart);
    const end = pageEnd ? Math.min(pageEnd, totalPages) : totalPages;

    const pages = [];

    for (let pageNum = start; pageNum <= end; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Join text items, preserving some spacing
      let lastY = null;
      let pageText = '';

      for (const item of textContent.items) {
        if (item.str === undefined) continue;

        // Detect line breaks by Y position change
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          pageText += ' ';
        }
        pageText += item.str;
        lastY = y;
      }

      pages.push({
        pageNum: pageNum,
        text: pageText.replace(/\s+/g, ' ').trim()
      });
    }

    return { pages, totalPages };
  }
}

// Make available globally
if (typeof self !== 'undefined') {
  self.PdfExtractor = PdfExtractor;
  self.pdfExtractor = new PdfExtractor();
}
