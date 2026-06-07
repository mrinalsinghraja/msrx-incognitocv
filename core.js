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

  async runInference(apiKey, model, systemPrompt, userContent) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.15,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      throw new Error(errorPayload?.error?.message || `Groq gateway returned ${response.status}.`);
    }

    const payload = await response.json();
    return payload.choices[0].message.content;
  },
};

const SYSTEM_PROMPT = `You are a precise, professional resume optimization engine running in a privacy-first sandbox.

Rules you must follow exactly:
1. Re-frame the candidate's existing achievements so they speak directly to the target job description's stated requirements and language.
2. Convert every bullet point into the XYZ structure: "Accomplished [X] as measured by [Y], by doing [Z]".
3. Never invent job titles, employers, dates, or metrics. If a number is missing, sharpen the framing of what is already there instead of fabricating one.
4. Return clean, production-ready Markdown only — no preamble, no commentary, no wrapping explanation.`;

const UI = {
  els: {},

  initializeInterface() {
    this.els = {
      apiKey: document.getElementById('apiKeyInput'),
      resume: document.getElementById('resumeInput'),
      job: document.getElementById('jobInput'),
      model: document.getElementById('modelSelect'),
      uploader: document.getElementById('pdfUploader'),
      dropzone: document.getElementById('dropzone'),
      dropHint: document.getElementById('dropHint'),
      overlay: document.getElementById('loadingOverlay'),
      output: document.getElementById('outputArea'),
    };

    if (window.lucide) lucide.createIcons();

    this.els.apiKey.value = AppCore.retrieveData('groq_key');
    this.els.resume.value = AppCore.retrieveData('resume_cache');
    this.els.job.value = AppCore.retrieveData('job_cache');
    const savedModel = AppCore.retrieveData('model_pref');
    if (savedModel) this.els.model.value = savedModel;

    this.els.apiKey.addEventListener('input', (e) => AppCore.persistData('groq_key', e.target.value.trim()));
    this.els.resume.addEventListener('input', (e) => AppCore.persistData('resume_cache', e.target.value));
    this.els.job.addEventListener('input', (e) => AppCore.persistData('job_cache', e.target.value));
    this.els.model.addEventListener('change', (e) => AppCore.persistData('model_pref', e.target.value));
    this.els.uploader.addEventListener('change', (e) => this.handlePDFImport(e));
    this.bindDropzone();
  },

  bindDropzone() {
    const zone = this.els.dropzone;
    let depth = 0;
    const show = () => this.els.dropHint.classList.remove('hidden');
    const hide = () => { depth = 0; this.els.dropHint.classList.add('hidden'); };

    zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; show(); });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('dragleave', (e) => { e.preventDefault(); depth--; if (depth <= 0) hide(); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      hide();
      this.importPDFFile(e.dataTransfer.files?.[0]);
    });
  },

  wipeAllData() {
    AppCore.purgeAllLocalState();
    this.els.apiKey.value = '';
    this.els.resume.value = '';
    this.els.job.value = '';
    this.els.output.value = '';
    this.els.model.selectedIndex = 0;
    alert('Everything cleared — nothing left in this browser.');
  },

  handlePDFImport(event) {
    this.importPDFFile(event.target.files?.[0]);
    event.target.value = '';
  },

  importPDFFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf') {
      alert("That isn't a PDF — drop a .pdf file or paste your resume text directly.");
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = await AppCore.extractTextFromPDF(reader.result);
        this.els.resume.value = text;
        AppCore.persistData('resume_cache', text);
      } catch (err) {
        alert('Could not parse that PDF locally — try pasting the resume text directly instead.');
      }
    };
    reader.readAsArrayBuffer(file);
  },

  async triggerExecutionPipeline() {
    const apiKey = this.els.apiKey.value.trim();
    const resume = this.els.resume.value.trim();
    const job = this.els.job.value.trim();
    const model = this.els.model.value;

    if (!apiKey || !resume || !job) {
      alert('Add your Groq key, resume text, and target job description before running.');
      return;
    }

    this.els.overlay.classList.remove('hidden');
    this.els.output.value = '';

    const userContent = `CANDIDATE PROFILE:\n${resume}\n\nTARGET JOB DESCRIPTION:\n${job}`;

    try {
      const result = await AppCore.runInference(apiKey, model, SYSTEM_PROMPT, userContent);
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
