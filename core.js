/**
 * MSRX IncognitoCV — headless core engine.
 * Decoupled from the DOM so this module can be reused inside a CapacitorJS shell untouched.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

const STORAGE_PREFIX = 'msrx_incognitocv_';

const AppCore = {
  persistData(key, payload) {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, payload);
  },

  retrieveData(key) {
    return localStorage.getItem(`${STORAGE_PREFIX}${key}`) || '';
  },

  purgeAllLocalState() {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(STORAGE_PREFIX))
      .forEach((key) => localStorage.removeItem(key));
  },

  async extractTextFromPDF(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    let fullText = '';
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      fullText += content.items.map((item) => item.str).join(' ') + '\n';
    }
    return fullText.trim();
  },

  async extractTextFromDocx(arrayBuffer) {
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    return value.trim();
  },

  async extractTextFromFile(file) {
    const buffer = await file.arrayBuffer();
    if (file.type === 'application/pdf') return this.extractTextFromPDF(buffer);
    if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return this.extractTextFromDocx(buffer);
    throw new Error('unsupported-file-type');
  },

  parseInlineRuns(text) {
    const runs = [];
    const re = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false, italic: false });
      if (m[1] !== undefined) runs.push({ text: m[1], bold: true, italic: true });
      else if (m[2] !== undefined) runs.push({ text: m[2], bold: true, italic: false });
      else runs.push({ text: m[3] ?? m[4], bold: false, italic: true });
      last = re.lastIndex;
    }
    if (last < text.length) runs.push({ text: text.slice(last), bold: false, italic: false });
    return runs.length ? runs : [{ text, bold: false, italic: false }];
  },

  parseMarkdownToBlocks(markdown) {
    const blocks = [];
    for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        blocks.push({ type: `h${heading[1].length}`, runs: this.parseInlineRuns(heading[2]) });
        continue;
      }
      const bullet = line.match(/^[-+*]\s+(.*)$/);
      if (bullet) {
        blocks.push({ type: 'bullet', runs: this.parseInlineRuns(bullet[1]) });
        continue;
      }
      blocks.push({ type: 'paragraph', runs: this.parseInlineRuns(line) });
    }
    return blocks;
  },

  async buildDocxBlob(blocks) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = docx;
    const accent = '2C3E50';
    const nameRule = { style: BorderStyle.SINGLE, size: 6, color: accent, space: 8 };
    const sectionRule = { style: BorderStyle.SINGLE, size: 4, color: 'B0B8C0', space: 6 };
    const toRuns = (runs, { uppercase, color } = {}) => runs.map((r) => new TextRun({
      text: uppercase ? r.text.toUpperCase() : r.text,
      bold: r.bold,
      italics: r.italic,
      color,
    }));

    const paragraphs = blocks.map((block) => {
      const level = parseInt(block.type.slice(1), 10) || 0;
      if (block.type === 'bullet') {
        return new Paragraph({
          children: toRuns(block.runs),
          bullet: { level: 0 },
          indent: { left: 360, hanging: 360 },
          spacing: { line: 264, after: 80 },
        });
      }
      if (block.type === 'h1') {
        return new Paragraph({
          children: toRuns(block.runs),
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          border: { bottom: nameRule },
        });
      }
      if (block.type === 'h2') {
        return new Paragraph({
          children: toRuns(block.runs, { uppercase: true, color: accent }),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 100 },
          border: { bottom: sectionRule },
        });
      }
      if (level >= 3) {
        return new Paragraph({
          children: toRuns(block.runs, { color: accent }),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 160, after: 80 },
        });
      }
      return new Paragraph({ children: toRuns(block.runs), spacing: { line: 264, after: 90 } });
    });

    const document = new Document({
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      sections: [{
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
        children: paragraphs,
      }],
    });
    return Packer.toBlob(document);
  },

  buildPdfBlob(blocks) {
    const { jsPDF } = jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const marginX = 50;
    const marginBottom = 50;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const maxWidth = pageWidth - marginX * 2;
    const fontSize = { h1: 20, h2: 12.5, h3: 11.5, h4: 11, h5: 10.5, h6: 10, bullet: 10, paragraph: 10 };
    const accent = [44, 62, 80];
    const faintRule = [176, 184, 192];
    const ink = [33, 33, 33];
    let y = 56;

    const ensureSpace = (height) => {
      if (y + height > pageHeight - marginBottom) {
        doc.addPage();
        y = 56;
      }
    };

    const rule = (color, weight) => {
      doc.setDrawColor(...color);
      doc.setLineWidth(weight);
      doc.line(marginX, y, pageWidth - marginX, y);
    };

    const styleFor = (bold, italic) => (bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal');

    // jsPDF can't mix styles within one text() call, so wrapped runs are laid out
    // word-by-word: measure each word in its own bold/italic style, wrap on overflow.
    const drawRuns = (runs, { x: startX, width, size, bulletAt }) => {
      const lineHeight = size * 1.32;
      const tokens = [];
      runs.forEach((r) => r.text.split(/(\s+)/).filter(Boolean)
        .forEach((text) => tokens.push({ text, bold: r.bold, italic: r.italic })));

      doc.setFontSize(size);
      ensureSpace(lineHeight);
      if (bulletAt !== undefined) {
        doc.setFont('helvetica', 'normal');
        doc.text('•', bulletAt, y);
      }

      let x = startX;
      tokens.forEach((t) => {
        doc.setFont('helvetica', styleFor(t.bold, t.italic));
        const w = doc.getTextWidth(t.text);
        if (x > startX && x + w > startX + width) {
          x = startX;
          y += lineHeight;
          ensureSpace(lineHeight);
        }
        doc.text(t.text, x, y);
        x += w;
      });
      y += lineHeight;
    };

    blocks.forEach((block, i) => {
      const isHeading = block.type.startsWith('h');
      const isBullet = block.type === 'bullet';
      const size = fontSize[block.type] ?? 10;
      const indent = isBullet ? 14 : 0;

      if (isHeading && i > 0) y += 10;

      if (isHeading) {
        const text = block.runs.map((r) => r.text).join('');
        const display = block.type === 'h2' ? text.toUpperCase() : text;
        const lineHeight = size * 1.32;
        doc.setFontSize(size);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...accent);
        doc.splitTextToSize(display, maxWidth).forEach((line) => {
          ensureSpace(lineHeight);
          doc.text(line, marginX, y);
          y += lineHeight;
        });
      } else {
        doc.setTextColor(...ink);
        drawRuns(block.runs, {
          x: marginX + indent,
          width: maxWidth - indent,
          size,
          bulletAt: isBullet ? marginX : undefined,
        });
      }

      y += isHeading ? 5 : 3;
      if (block.type === 'h1') {
        y += 6;
        rule(accent, 1.1);
        y += 16;
      } else if (block.type === 'h2') {
        rule(faintRule, 0.6);
        y += 12;
      }
    });

    return doc.output('blob');
  },

  sanitizeFilenameBase(raw) {
    return (raw || '')
      .replace(/\.[a-zA-Z0-9]{1,5}$/, '')
      .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60)
      .replace(/^[_-]+|[_-]+$/g, '');
  },

  async runInference(model, resume, job) {
    const response = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, resume, job }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || `Optimization engine returned ${response.status}.`);
    }

    return payload.result;
  },
};

const UI = {
  els: {},

  initializeInterface() {
    this.els = {
      resume: document.getElementById('resumeInput'),
      job: document.getElementById('jobInput'),
      model: document.getElementById('modelSelect'),
      resumeUploader: document.getElementById('resumeUploader'),
      resumeDropzone: document.getElementById('resumeDropzone'),
      resumeDropHint: document.getElementById('resumeDropHint'),
      jobUploader: document.getElementById('jobUploader'),
      jobDropzone: document.getElementById('jobDropzone'),
      jobDropHint: document.getElementById('jobDropHint'),
      overlay: document.getElementById('loadingOverlay'),
      output: document.getElementById('outputArea'),
      clearAllBtn: document.getElementById('clearAllBtn'),
      optimizeBtn: document.getElementById('optimizeBtn'),
      copyOutputBtn: document.getElementById('copyOutputBtn'),
      downloadWordBtn: document.getElementById('downloadWordBtn'),
      downloadPdfBtn: document.getElementById('downloadPdfBtn'),
    };

    if (window.lucide) lucide.createIcons();

    this.els.resume.value = AppCore.retrieveData('resume_cache');
    this.els.job.value = AppCore.retrieveData('job_cache');
    this.resumeFileBaseName = AppCore.retrieveData('resume_filename_cache');
    const savedModel = AppCore.retrieveData('model_pref');
    if (savedModel) this.els.model.value = savedModel;

    this.els.resume.addEventListener('input', (e) => {
      AppCore.persistData('resume_cache', e.target.value);
      this.resumeFileBaseName = '';
      AppCore.persistData('resume_filename_cache', '');
    });
    this.els.job.addEventListener('input', (e) => AppCore.persistData('job_cache', e.target.value));
    this.els.model.addEventListener('change', (e) => AppCore.persistData('model_pref', e.target.value));
    this.els.resumeUploader.addEventListener('change', (e) => this.handleFileImport(e, this.els.resume, 'resume_cache'));
    this.els.jobUploader.addEventListener('change', (e) => this.handleFileImport(e, this.els.job, 'job_cache'));
    this.bindDropzone(this.els.resumeDropzone, this.els.resumeDropHint, this.els.resume, 'resume_cache');
    this.bindDropzone(this.els.jobDropzone, this.els.jobDropHint, this.els.job, 'job_cache');

    this.els.clearAllBtn.addEventListener('click', () => this.wipeAllData());
    this.els.optimizeBtn.addEventListener('click', () => this.triggerExecutionPipeline());
    this.els.copyOutputBtn.addEventListener('click', () => this.copyOutput());
    this.els.downloadWordBtn.addEventListener('click', () => this.downloadAsWord());
    this.els.downloadPdfBtn.addEventListener('click', () => this.downloadAsPdf());
  },

  bindDropzone(zone, hint, targetField, cacheKey) {
    let depth = 0;
    const show = () => hint.classList.remove('hidden');
    const hide = () => { depth = 0; hint.classList.add('hidden'); };

    zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; show(); });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('dragleave', (e) => { e.preventDefault(); depth--; if (depth <= 0) hide(); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      hide();
      this.importDocumentFile(e.dataTransfer.files?.[0], targetField, cacheKey);
    });
  },

  wipeAllData() {
    AppCore.purgeAllLocalState();
    this.els.resume.value = '';
    this.els.job.value = '';
    this.els.output.value = '';
    this.els.model.selectedIndex = 0;
    this.resumeFileBaseName = '';
    alert('Everything cleared — nothing left in this browser.');
  },

  handleFileImport(event, targetField, cacheKey) {
    this.importDocumentFile(event.target.files?.[0], targetField, cacheKey);
    event.target.value = '';
  },

  async importDocumentFile(file, targetField, cacheKey) {
    if (!file) return;

    const supportedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!supportedTypes.includes(file.type)) {
      alert("That file type isn't supported — upload a PDF or Word (.docx) file, or paste the text directly.");
      return;
    }

    try {
      const text = await AppCore.extractTextFromFile(file);
      targetField.value = text;
      AppCore.persistData(cacheKey, text);
      if (cacheKey === 'resume_cache') {
        this.resumeFileBaseName = file.name.replace(/\.[a-zA-Z0-9]{1,5}$/, '');
        AppCore.persistData('resume_filename_cache', this.resumeFileBaseName);
      }
    } catch (err) {
      alert('Could not read that file locally — try pasting the text directly instead.');
    }
  },

  async triggerExecutionPipeline() {
    const resume = this.els.resume.value.trim();
    const job = this.els.job.value.trim();
    const model = this.els.model.value;

    if (!resume || !job) {
      alert('Add your resume text and target job description before running.');
      return;
    }

    this.els.overlay.classList.remove('hidden');
    this.els.output.value = '';

    try {
      const result = await AppCore.runInference(model, resume, job);
      // .value assignment only (never innerHTML) — a hostile resume/job payload can't get rendered as markup.
      this.els.output.value = result;
    } catch (err) {
      this.els.output.value = `Run failed:\n${err.message}`;
    } finally {
      this.els.overlay.classList.add('hidden');
    }
  },

  deriveOutputFilenameBase() {
    const fromFile = AppCore.sanitizeFilenameBase(this.resumeFileBaseName);
    if (fromFile) return fromFile;
    const firstLine = (this.els.resume.value.split('\n').find((l) => l.trim()) || '').trim();
    return AppCore.sanitizeFilenameBase(firstLine) || 'resume';
  },

  triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  async downloadAsWord() {
    if (!this.els.output.value.trim()) return;
    try {
      const blocks = AppCore.parseMarkdownToBlocks(this.els.output.value);
      const blob = await AppCore.buildDocxBlob(blocks);
      this.triggerDownload(blob, `${this.deriveOutputFilenameBase()}_optimized.docx`);
    } catch (err) {
      alert('Could not generate the Word file — copy the Markdown instead.');
    }
  },

  downloadAsPdf() {
    if (!this.els.output.value.trim()) return;
    try {
      const blocks = AppCore.parseMarkdownToBlocks(this.els.output.value);
      const blob = AppCore.buildPdfBlob(blocks);
      this.triggerDownload(blob, `${this.deriveOutputFilenameBase()}_optimized.pdf`);
    } catch (err) {
      alert('Could not generate the PDF — copy the Markdown instead.');
    }
  },

  copyOutput() {
    const output = this.els.output;
    if (!output.value) return;
    navigator.clipboard
      .writeText(output.value)
      .then(() => alert('Markdown copied to clipboard.'))
      .catch(() => {
        output.select();
        document.execCommand('copy');
        alert('Markdown copied to clipboard.');
      });
  },
};

document.addEventListener('DOMContentLoaded', () => UI.initializeInterface());
