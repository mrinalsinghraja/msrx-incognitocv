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
    };

    if (window.lucide) lucide.createIcons();

    this.els.resume.value = AppCore.retrieveData('resume_cache');
    this.els.job.value = AppCore.retrieveData('job_cache');
    const savedModel = AppCore.retrieveData('model_pref');
    if (savedModel) this.els.model.value = savedModel;

    this.els.resume.addEventListener('input', (e) => AppCore.persistData('resume_cache', e.target.value));
    this.els.job.addEventListener('input', (e) => AppCore.persistData('job_cache', e.target.value));
    this.els.model.addEventListener('change', (e) => AppCore.persistData('model_pref', e.target.value));
    this.els.resumeUploader.addEventListener('change', (e) => this.handleFileImport(e, this.els.resume, 'resume_cache'));
    this.els.jobUploader.addEventListener('change', (e) => this.handleFileImport(e, this.els.job, 'job_cache'));
    this.bindDropzone(this.els.resumeDropzone, this.els.resumeDropHint, this.els.resume, 'resume_cache');
    this.bindDropzone(this.els.jobDropzone, this.els.jobDropHint, this.els.job, 'job_cache');

    this.els.clearAllBtn.addEventListener('click', () => this.wipeAllData());
    this.els.optimizeBtn.addEventListener('click', () => this.triggerExecutionPipeline());
    this.els.copyOutputBtn.addEventListener('click', () => this.copyOutput());
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
