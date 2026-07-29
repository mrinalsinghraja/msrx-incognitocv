/**
 * MSRX IncognitoCV — Darkroom redesign, behaviour layer.
 * ---------------------------------------------------------------------------
 * Loaded AFTER core.js and BEFORE its DOMContentLoaded handler fires, so every
 * override below is in place by the time UI.initializeInterface() runs. core.js
 * itself is not modified — that is deliberate: index.html keeps working exactly
 * as it does today, and this redesign can be reverted by deleting three files.
 *
 * core.js declares RESUME_THEMES / AppCore / UI as top-level `const` in a
 * classic script, which puts them in the shared global declarative scope. They
 * are readable from here without any export plumbing.
 *
 * Every listener is addEventListener. The site's CSP is `script-src 'self'
 * <cdn allowlist>` with no 'unsafe-inline', which compiles any inline onclick=
 * attribute to a null handler with no console error and no CSP report — the
 * failure mode that killed all three action buttons on 2026-06-07.
 */
(function () {
  'use strict';

  /* --- Toasts -------------------------------------------------------------
     core.js signals eight different outcomes with window.alert(). A modal OS
     dialog is the loudest "weekend project" tell a polished tool can emit, and
     it blocks the page. Replacing the global is a one-line intercept that
     catches all eight call sites without editing core.js. */
  const stack = document.getElementById('toastStack');

  function toast(message) {
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = String(message);          // textContent, never innerHTML —
    stack.appendChild(el);                     // messages can contain API error
    setTimeout(() => el.remove(), 5200);       // text derived from user input.
  }
  window.alert = toast;

  /* --- Helpers ------------------------------------------------------------ */
  const firstLine = (text) => (text || '').split('\n').find((l) => l.trim())?.trim() || '';
  const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  /* --- Theme selection ----------------------------------------------------
     The redesign's central move: the strip is a selector, and the big lit page
     is the thing it selects. core.js's zoom modal becomes unnecessary. */
  UI.selectedThemeId = RESUME_THEMES[0].id;

  UI.currentTheme = function () {
    return RESUME_THEMES.find((t) => t.id === this.selectedThemeId) || RESUME_THEMES[0];
  };

  UI.paintStage = function () {
    const page = document.getElementById('stagePage');
    if (!page) return;
    if (!this.previewBlocks) { page.replaceChildren(); return; }
    page.replaceChildren(AppCore.renderResumePreview(this.previewBlocks, this.currentTheme()));
  };

  UI.selectTheme = function (themeId) {
    this.selectedThemeId = themeId;
    document.querySelectorAll('.preview-card').forEach((card) => {
      const on = card.dataset.themeId === themeId;
      card.classList.toggle('is-selected', on);
      card.querySelector('.preview-thumb-wrap')?.setAttribute('aria-checked', String(on));
    });
    this.paintStage();
  };

  /* Replaces core.js's version. Same three capabilities per card as the current
     site — select/zoom, Word, PDF — but the zoom is now "put it on the stage"
     and the two export buttons only surface on hover or keyboard focus. */
  UI.bindPreviewCards = function () {
    const cards = Array.from(this.els.previewCards);
    cards.forEach((card, i) => {
      const theme = RESUME_THEMES.find((t) => t.id === card.dataset.themeId);
      if (!theme) return;
      const trigger = card.querySelector('.preview-thumb-wrap');
      if (!trigger) return;

      // Per-style export, unchanged in behaviour from the current site: any of
      // the ten can be downloaded without first selecting it.
      card.querySelector('.preview-word-btn')
        ?.addEventListener('click', () => this.downloadThemedFile('docx', theme));
      card.querySelector('.preview-pdf-btn')
        ?.addEventListener('click', () => this.downloadThemedFile('pdf', theme));

      trigger.addEventListener('click', () => this.selectTheme(theme.id));
      trigger.addEventListener('keydown', (e) => {
        // role="radio" inside a radiogroup: Enter/Space select, arrows move.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.selectTheme(theme.id);
          return;
        }
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
                   : e.key === 'ArrowLeft'  || e.key === 'ArrowUp'   ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = cards[(i + step + cards.length) % cards.length];
        this.selectTheme(next.dataset.themeId);
        next.querySelector('.preview-thumb-wrap')?.focus();
      });
    });
  };

  // The zoom modal is gone — the stage shows the page full size at all times.
  // The modal's five nodes stay in the DOM only because initializeInterface()
  // caches them without a null check.
  UI.openPreviewModal = function () {};
  UI.closePreviewModal = function () {};

  /* --- State A / State B --------------------------------------------------
     renderThemePreviews is the one place the app already knows whether a
     rewrite exists, so it is the only honest place to drive the layout from.
     Nothing about state B is guessed at from a click or a timer. */
  const renderThumbs = UI.renderThemePreviews.bind(UI);

  UI.renderThemePreviews = function (markdown) {
    renderThumbs(markdown);
    const hasOutput = Boolean(this.previewBlocks);
    document.body.classList.toggle('has-output', hasOutput);
    document.body.classList.remove('is-editing');

    if (hasOutput) {
      this.selectTheme(this.selectedThemeId);
      this.refreshRail();
    } else {
      this.paintStage();
    }
    // Also covers wipeAllData(), which routes through here with ''.
    this.refreshActionState();
    this.refreshExportState(hasOutput);
    this.renderReport();
  };

  /* The gallery, the exports and the raw-Markdown panel are on screen from the
     first paint, same as the current site. They are simply inert until there
     is a rewrite — the current site lets you click Word with an empty output
     and silently does nothing, which is worse than saying so. */
  UI.refreshExportState = function (hasOutput) {
    [this.els.downloadWordBtn, this.els.downloadPdfBtn, this.els.copyOutputBtn]
      .forEach((btn) => {
        if (!btn) return;
        btn.disabled = !hasOutput;
        btn.title = hasOutput ? '' : 'Rewrite your resume first';
      });
    document.querySelectorAll('.thumb-btn').forEach((btn) => { btn.disabled = !hasOutput; });
    document.querySelector('.raw')?.setAttribute('data-empty', String(!hasOutput));
  };

  UI.refreshRail = function () {
    const resumeCell = document.getElementById('railResume');
    const jobCell = document.getElementById('railJob');
    const modelCell = document.getElementById('railModel');
    if (resumeCell) {
      resumeCell.textContent =
        truncate(this.resumeFileBaseName || firstLine(this.els.resume.value) || '—', 34);
    }
    if (jobCell) {
      jobCell.textContent = truncate(firstLine(this.els.job.value) || '—', 34);
    }
    if (modelCell) {
      const opt = this.els.model.selectedOptions[0];
      modelCell.textContent = opt ? opt.textContent.split('—')[0].trim() : '—';
    }
  };

  /* The primary action knows whether it can do anything. core.js's guard is an
     alert() fired after the click; stating the requirement on the control
     itself means you never reach the error in the first place. */
  UI.refreshActionState = function () {
    const btn = this.els.optimizeBtn;
    const hint = document.getElementById('actionHint');
    if (!btn) return;
    const hasResume = Boolean(this.els.resume.value.trim());
    const hasJob = Boolean(this.els.job.value.trim());
    btn.disabled = !(hasResume && hasJob);

    let message = '';
    if (!hasResume && !hasJob) message = 'Add your CV and the job posting to start.';
    else if (!hasResume) message = 'Add your CV to start.';
    else if (!hasJob) message = 'Add the job posting to start.';
    btn.setAttribute('aria-describedby', 'actionHint');
    if (hint) hint.textContent = message;
  };

  /* --- Exports ------------------------------------------------------------
     The header's Word/PDF buttons used to always emit the hardcoded "Clean"
     look regardless of which style you were looking at. Now they follow the
     stage, which is what "download this" means to anyone using it. */
  UI.downloadAsWord = function () {
    if (!this.previewBlocks) return;
    return this.downloadThemedFile('docx', this.currentTheme());
  };
  UI.downloadAsPdf = function () {
    if (!this.previewBlocks) return;
    return this.downloadThemedFile('pdf', this.currentTheme());
  };

  /* =========================================================================
     Streaming
     -------------------------------------------------------------------------
     core.js waits for the whole completion and then paints. A rewrite takes
     eight to fifteen seconds, which is a long time to watch a spinner and
     wonder whether it has hung. Streaming turns that into about one second to
     first word, and the typeset page fills in as the model writes it.

     The server sends its own small protocol (`data: {"delta": "..."}`) rather
     than passing the vendor's frames through, so this reader does not depend
     on Groq's response shape.
     ========================================================================= */
  UI.streamCompletion = async function ({ mode, onDelta, signal }) {
    const response = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: this.els.model.value,
        resume: this.els.resume.value.trim(),
        job: this.els.job.value.trim(),
        mode,
        stream: true,
      }),
    });

    // An error before the stream opens still arrives as JSON with a real status.
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `The engine returned ${response.status}.`);
    }
    if (!response.body) throw new Error('Streaming is not available in this browser.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n');
      buffer = frames.pop() || '';   // trailing fragment waits for more bytes

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.delta) { text += parsed.delta; onDelta(text, parsed.delta); }
      }
    }
    return text;
  };

  /* Replaces core.js's request/paint cycle. Same guarantees — output only ever
     reaches the DOM through .value or the safe-DOM preview renderer, never
     innerHTML — but painted progressively and followed by the fit report. */
  UI.triggerExecutionPipeline = async function () {
    const resume = this.els.resume.value.trim();
    const job = this.els.job.value.trim();
    if (!resume || !job) { this.refreshActionState(); return; }

    this.els.overlay.classList.remove('hidden');
    document.body.classList.add('is-streaming');
    this.els.output.value = '';

    // Repainting ten thumbnails on every token would burn the main thread for
    // no benefit — the stage page updates live, the gallery catches up on a
    // slower beat and once more at the end.
    let lastGalleryPaint = 0;
    let firstDelta = true;

    try {
      const finalText = await this.streamCompletion({
        mode: 'resume',
        onDelta: (text) => {
          // The overlay covers the page it is waiting for, so it only earns its
          // place until the first token lands. After that the page itself is
          // the progress indicator and the overlay would be hiding the one
          // thing streaming exists to show.
          if (firstDelta) {
            firstDelta = false;
            this.els.overlay.classList.add('hidden');
          }
          this.els.output.value = text;
          this.previewBlocks = AppCore.parseMarkdownToBlocks(text);
          document.body.classList.add('has-output');
          this.paintStage();
          if (Date.now() - lastGalleryPaint > 700) {
            lastGalleryPaint = Date.now();
            this.paintThumbnails();
          }
        },
        signal: undefined,
      });

      if (!finalText.trim()) throw new Error('The engine returned an empty response. Try again.');
      this.renderThemePreviews(finalText);
    } catch (err) {
      this.els.output.value = '';
      this.renderThemePreviews('');
      alert(err.message || 'The rewrite failed. Try again.');
    } finally {
      document.body.classList.remove('is-streaming');
      this.els.overlay.classList.add('hidden');
    }
  };

  // Split out of renderThemePreviews so the streaming loop can repaint the
  // gallery on its own cadence without also re-running the state machinery.
  UI.paintThumbnails = function () {
    this.els.previewCards.forEach((card) => {
      const theme = RESUME_THEMES.find((t) => t.id === card.dataset.themeId);
      const thumb = card.querySelector('[data-role="thumb"]');
      if (!theme || !thumb) return;
      thumb.replaceChildren();
      if (this.previewBlocks) thumb.appendChild(AppCore.renderResumePreview(this.previewBlocks, theme));
    });
  };

  /* =========================================================================
     Fit report
     ========================================================================= */
  const REPORT = {};

  function chip(entry) {
    const li = document.createElement('li');
    li.textContent = entry.term;
    if (entry.hard) li.className = 'is-hard';
    return li;
  }

  function verdictLine(report) {
    const { level } = report;
    const bits = [];
    if (level.yearsRequired != null) bits.push(`Posting asks for ${level.yearsRequired}+ years`);
    if (level.jobLevel !== 'Unspecified') bits.push(`${level.jobLevel} level`);
    if (level.yearsShortfall > 0) bits.push(`your CV shows about ${level.yearsHave}`);
    else if (level.verdict === 'above') bits.push('your CV reads more senior');
    else if (level.verdict === 'aligned') bits.push('your CV matches that level');
    return bits.join(' · ');
  }

  function scoreCaption(score, hasAfter) {
    if (score >= 80) return hasAfter ? 'Strong match. Worth applying as-is.' : 'Already a strong match.';
    if (score >= 60) return 'Solid. Closing the gaps on the right would push it higher.';
    if (score >= 40) return 'Partial match — the terms on the right are what a screen looks for.';
    return 'Low overlap. Either the CV is missing the posting\'s language, or this is not the right role.';
  }

  UI.renderReport = function () {
    const panel = document.getElementById('reportPanel');
    if (!panel || typeof MatchEngine === 'undefined') return;

    const resume = this.els.resume.value.trim();
    const job = this.els.job.value.trim();
    const optimized = this.els.output.value.trim();

    // Nothing to say until there are two texts to compare.
    if (!resume || !job) { panel.hidden = true; return; }

    const report = MatchEngine.analyze(resume, job, optimized || undefined);
    REPORT.last = report;
    panel.hidden = false;

    const shown = report.after || report.before;
    document.getElementById('gaugeRing').style.setProperty('--pct', String(shown.score));
    document.getElementById('gaugeScore').textContent = String(shown.score);
    document.getElementById('gaugeCaption').textContent = scoreCaption(shown.score, Boolean(report.after));

    const deltaEl = document.getElementById('gaugeDelta');
    deltaEl.textContent = report.delta != null && report.delta !== 0
      ? `${report.delta > 0 ? '+' : ''}${report.delta} from ${report.before.score}`
      : '';

    document.getElementById('reportSub').textContent =
      verdictLine(report) || `${report.keywords.length} terms read out of the posting`;

    const gaps = report.topGaps;
    document.getElementById('gapCount').textContent = gaps.length ? `(${gaps.length})` : '';
    document.getElementById('gapList').replaceChildren(...gaps.map(chip));
    document.getElementById('gapHint').textContent = gaps.length
      ? 'Add any of these to your CV only where they are genuinely true of your experience, then re-run.'
      : 'Nothing significant missing — this CV covers the posting\'s language.';

    const gainCol = document.getElementById('gainCol');
    if (report.gained.length) {
      gainCol.hidden = false;
      document.getElementById('gainCount').textContent = `(${report.gained.length})`;
      document.getElementById('gainList').replaceChildren(...report.gained.slice(0, 14).map(chip));
    } else {
      gainCol.hidden = true;
    }

    const atsCol = document.getElementById('atsCol');
    if (report.structure) {
      atsCol.hidden = false;
      const list = document.getElementById('atsList');
      if (!report.structure.findings.length) {
        const li = document.createElement('li');
        li.className = 'is-pass';
        const b = document.createElement('b');
        b.textContent = 'Clean parse';
        li.append(b, document.createTextNode(
          `${report.structure.stats.words} words, ${report.structure.stats.bullets} bullets, ${report.structure.stats.quantified} with numbers. No tables, images or columns to confuse a parser.`));
        list.replaceChildren(li);
      } else {
        list.replaceChildren(...report.structure.findings.map((f) => {
          const li = document.createElement('li');
          li.className = f.level === 'fail' ? 'is-fail' : 'is-warn';
          const b = document.createElement('b');
          b.textContent = f.label;
          li.append(b, document.createTextNode(f.detail));
          return li;
        }));
      }
    } else {
      atsCol.hidden = true;
    }
  };

  /* =========================================================================
     Cover letter
     ========================================================================= */
  UI.generateCoverLetter = async function () {
    const panel = document.getElementById('coverPanel');
    const area = document.getElementById('coverArea');
    const btn = document.getElementById('coverLetterBtn');
    if (!panel || !area) return;
    if (!this.els.resume.value.trim() || !this.els.job.value.trim()) {
      alert('Add your CV and the job posting first.');
      return;
    }

    panel.hidden = false;
    panel.open = true;
    area.value = '';
    btn.disabled = true;

    try {
      await this.streamCompletion({ mode: 'cover', onDelta: (text) => { area.value = text; } });
    } catch (err) {
      area.value = '';
      alert(err.message || 'Could not write the cover letter. Try again.');
    } finally {
      btn.disabled = false;
    }
  };

  UI.downloadCoverLetter = async function () {
    const text = document.getElementById('coverArea')?.value.trim();
    if (!text) return;
    try {
      const blocks = AppCore.parseMarkdownToBlocks(text);
      const blob = await AppCore.buildDocxBlob(blocks, this.currentTheme());
      this.triggerDownload(blob, `${this.deriveOutputFilenameBase()}_cover_letter.docx`);
    } catch {
      alert('Could not build the Word file — copy the text instead.');
    }
  };

  /* --- Reopening the inputs -----------------------------------------------
     Progressive disclosure that reverses cleanly: the composer is not deleted
     once you have a page, it is a finished step you can step back into. */
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('editInputsBtn')?.addEventListener('click', () => {
      document.body.classList.add('is-editing');
      document.getElementById('resumeInput')?.focus();
    });

    // "Clear everything" has to work in both states. #clearAllBtn is the one
    // core.js binds (state A); this proxies the rail's copy to the same action
    // rather than duplicating wipeAllData's behaviour.
    document.getElementById('railClearBtn')?.addEventListener('click', () => UI.wipeAllData());

    document.getElementById('coverLetterBtn')?.addEventListener('click', () => UI.generateCoverLetter());
    document.getElementById('coverRegenBtn')?.addEventListener('click', () => UI.generateCoverLetter());
    document.getElementById('coverWordBtn')?.addEventListener('click', () => UI.downloadCoverLetter());
    document.getElementById('coverCopyBtn')?.addEventListener('click', () => {
      const text = document.getElementById('coverArea')?.value || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => alert('Cover letter copied.')).catch(() => {});
    });
    document.getElementById('reportRefresh')?.addEventListener('click', () => UI.renderReport());

    // Scoring is pure arithmetic over two strings, but it still runs on the
    // main thread on every keystroke otherwise. 400ms after typing stops is
    // below the threshold where it feels delayed and well above the cost.
    let scoreTimer = null;
    const scoreSoon = () => {
      clearTimeout(scoreTimer);
      scoreTimer = setTimeout(() => UI.renderReport(), 400);
    };

    const sync = () => { UI.refreshRail(); UI.refreshActionState(); scoreSoon(); };
    ['resumeInput', 'jobInput'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', sync);
    });
    document.getElementById('modelSelect')?.addEventListener('change', sync);

    // A dropped or browsed file sets .value programmatically, which fires no
    // input event — without this the button would stay disabled after an
    // upload. importDocumentFile is async, so chain off its promise.
    const importFile = UI.importDocumentFile.bind(UI);
    UI.importDocumentFile = function (...args) {
      return Promise.resolve(importFile(...args)).finally(sync);
    };

    sync();   // cached resume/job are restored before this runs.
    UI.refreshExportState(Boolean(UI.previewBlocks));
    UI.renderReport();
  });
})();
