/**
 * MSRX IncognitoCV — headless core engine.
 * Decoupled from the DOM so this module can be reused inside a CapacitorJS shell untouched.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

const STORAGE_PREFIX = 'msrx_incognitocv_';

// Ten visual themes for the resume preview gallery (2 rows x 5) — same
// optimized content, ten distinct structural treatments, shared verbatim by
// the DOCX, PDF, and HTML preview renderers so every surface stays in sync.
// `accent`/`faint` are 6-digit hex strings (no leading #).
//
// Redesigned from the old 5-theme set after the user pointed at a Canva
// gallery (sidebar/banner/badge/dense/airy/serif-sans layouts) and asked for
// ten that differ in "style, font, even content [layout]" — not re-tints of
// one shape. The old schema's *entire* variation surface was 2 colors + one
// binary `serif` flag; that ceiling is exactly why 4-of-5 collapsed into one
// muted-gray cluster the first time round (see the old fix note this
// replaced). New schema adds three structural axes so neighbors differ in
// *shape*, not just hue:
//   nameFont/bodyFont  'serif' | 'sans'  — independent, so e.g. a serif
//                                           display name can pair with a sans
//                                           body (Boulevard, Atelier)
//   nameStyle    'rule'      centered name, accent rule beneath   (legacy)
//                'band'      full-width accent fill, reversed text, left-set
//                'monogram'  initials badge beside left-set name
//                'sideRule'  vertical accent bar beside name block
//   sectionStyle 'underline' accent caps + faint rule beneath     (legacy)
//                'bracket'   "[ SECTION ]" in monospace, no rule
//                'band'      accent-filled tag, reversed text
//   density      'compact' | 'normal' | 'spacious' — spacing/line-height
//                multiplier ONLY, see DENSITY_SCALE. Type sizes never scale,
//                so every theme stays equally legible: compact reads as
//                tighter rhythm, never smaller print.
// `rule`/`underline`/`sans`/`sans`/`normal` are the passthrough defaults —
// they reproduce the ORIGINAL fixed layout exactly, which is what keeps slot
// 0 byte-identical (see lock note below).
//
// Palette: hand-picked first (again) and failed (again) — min pairwise
// distance 33, five pairs under the 60 floor, *and* a mid-process "too vivid"
// gut-correction on two already-searched colors re-collapsed a passing set to
// min-42 before getting reverted. Identical root cause to the Phase-C bug:
// trusting eyeballed intuition over verified numbers. Same fix as that
// rescue: throw out intuition, search a constrained hue x saturation x
// lightness grid programmatically, greedily keep whichever candidate
// maximizes the *minimum* distance to every color already chosen. Final set:
// min pairwise RGB distance 67.8 (zero pairs under 60 — matches the proven
// Phase-C benchmark almost exactly), luminance spread 23%-67% with no
// clustering, saturation held to 0.20-0.42 for a muted/professional register.
//
// Theme 0 ("Clean")'s accent/faint are the two values the pre-gallery header
// Word/PDF buttons have always hardcoded — changing either would change what
// those long-standing buttons produce. Locked as-is; only id/label may
// change (and didn't even change this round — kept 'clean'/'Clean').
const RESUME_THEMES = [
  { id: 'clean',     label: 'Clean',     accent: '2C3E50', faint: 'B0B8C0', nameFont: 'sans',  bodyFont: 'sans',  nameStyle: 'rule',     sectionStyle: 'underline', density: 'normal'   },
  { id: 'banner',    label: 'Banner',    accent: 'B8B151', faint: 'DFDECE', nameFont: 'sans',  bodyFont: 'sans',  nameStyle: 'band',     sectionStyle: 'underline', density: 'normal'   },
  { id: 'signal',    label: 'Signal',    accent: '51A3B8', faint: 'CEDBDF', nameFont: 'sans',  bodyFont: 'sans',  nameStyle: 'rule',     sectionStyle: 'bracket',   density: 'normal'   },
  { id: 'monogram',  label: 'Monogram',  accent: 'B851B1', faint: 'DFCEDE', nameFont: 'sans',  bodyFont: 'sans',  nameStyle: 'monogram', sectionStyle: 'underline', density: 'normal'   },
  { id: 'brief',     label: 'Brief',     accent: '91523B', faint: 'DFD2CE', nameFont: 'sans',  bodyFont: 'sans',  nameStyle: 'rule',     sectionStyle: 'bracket',   density: 'compact'  },
  { id: 'ledger',    label: 'Ledger',    accent: '51B851', faint: 'CEDFCE', nameFont: 'serif', bodyFont: 'serif', nameStyle: 'sideRule', sectionStyle: 'underline', density: 'normal'   },
  { id: 'boulevard', label: 'Boulevard', accent: '693B91', faint: 'D7CEDF', nameFont: 'serif', bodyFont: 'sans',  nameStyle: 'rule',     sectionStyle: 'underline', density: 'spacious' },
  { id: 'ribbon',    label: 'Ribbon',    accent: '527A78', faint: 'D2DADA', nameFont: 'serif', bodyFont: 'sans',  nameStyle: 'band',     sectionStyle: 'band',      density: 'normal'   },
  { id: 'foundry',   label: 'Foundry',   accent: '4F6D2C', faint: 'D7DFCE', nameFont: 'sans',  bodyFont: 'sans',  nameStyle: 'monogram', sectionStyle: 'bracket',   density: 'compact'  },
  { id: 'atelier',   label: 'Atelier',   accent: '9D6C79', faint: 'DAD2D4', nameFont: 'serif', bodyFont: 'sans',  nameStyle: 'sideRule', sectionStyle: 'band',      density: 'spacious' },
];

// Spacing/line-height multiplier for `density` — deliberately the ONLY thing
// density touches (never font size, see schema note above). Threaded through
// DOCX `spacing.{before,after,line}`, PDF line-height/cursor advances, and
// the DOM preview's `--rp-density` custom property. `normal` is 1 (no-op),
// which is what keeps slot 0 byte-identical to the legacy fixed spacing.
const DENSITY_SCALE = { compact: 0.86, normal: 1, spacious: 1.15 };

// Font stacks for `nameFont`/`bodyFont`, shared by the DOM preview via CSS
// custom properties — same families the DOCX (Cambria/Calibri) and PDF
// (times/helvetica) renderers already use, so the live preview's pairing
// reads as the same theme rather than a web-font approximation of it.
const FONT_STACKS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
};

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

  // Converts a 6-digit hex color string (no leading #) to an [r,g,b] array —
  // jsPDF's color APIs (setTextColor/setDrawColor) take RGB components, while
  // themes store colors as hex strings shared with the DOCX/HTML renderers.
  hexToRgb(hex) {
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  },

  // Feeds the `monogram` nameStyle's badge (PDF/DOM) and bracket-prefix (DOCX,
  // which has no shape-drawing API to badge with). First letter of the first
  // two words; single-word names fall back to that word's first two letters.
  // Always uppercase, always non-empty for any non-blank input.
  deriveInitials(name) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  },

  async buildDocxBlob(blocks, theme = RESUME_THEMES[0]) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, ShadingType } = docx;
    const accent = theme.accent;
    const reverse = 'FFFFFF';
    const nameFontFamily = theme.nameFont === 'serif' ? 'Cambria' : 'Calibri';
    const bodyFontFamily = theme.bodyFont === 'serif' ? 'Cambria' : 'Calibri';
    // Explicit run-level font ONLY when the name face actually differs from
    // the document default (= bodyFontFamily): an explicit font equal to the
    // inherited one still serializes a <w:rFonts> the original run never
    // carried, which would break the byte-identical lock on theme 0 — and on
    // every other matched-pairing theme, where nameFont === bodyFont too.
    const nameRunFont = nameFontFamily !== bodyFontFamily ? nameFontFamily : undefined;
    const scale = DENSITY_SCALE[theme.density] ?? 1;
    const sp = (n) => Math.round(n * scale);
    const nameRule = { style: BorderStyle.SINGLE, size: 6, color: accent, space: 8 };
    const sectionRule = { style: BorderStyle.SINGLE, size: 4, color: theme.faint, space: 6 };
    const sideRuleBorder = { style: BorderStyle.SINGLE, size: 24, color: accent, space: 12 };
    const accentShading = { type: ShadingType.CLEAR, color: 'auto', fill: accent };
    const toRuns = (runs, { uppercase, color, font, bold } = {}) => runs.map((r) => new TextRun({
      text: uppercase ? r.text.toUpperCase() : r.text,
      bold: bold !== undefined ? bold : r.bold,
      italics: r.italic,
      color,
      font,
    }));

    // h1 (name) paragraph shape per nameStyle. Parameterized by the block's
    // OWN runs — not hoisted/precomputed — so a malformed multi-h1 document
    // still renders each occurrence from its own text, matching how every
    // other block type here already works off `block.runs` directly.
    const nameProps = (runs) => {
      const text = runs.map((r) => r.text).join('');
      switch (theme.nameStyle) {
        case 'band':
          return {
            children: toRuns(runs, { color: reverse, font: nameRunFont }),
            alignment: AlignmentType.LEFT,
            shading: accentShading,
            spacing: { line: 380, before: sp(40), after: sp(220) },
          };
        case 'monogram':
          // No shape-drawing API in docx.js to badge with — bracketed,
          // accent-bold initials stand in as the DOCX analog of the
          // PDF/DOM circular badge (graceful per-format degradation).
          return {
            children: [
              new TextRun({ text: `[${this.deriveInitials(text)}]  `, bold: true, color: accent, font: bodyFontFamily }),
              ...toRuns(runs, { font: nameRunFont }),
            ],
            alignment: AlignmentType.LEFT,
            spacing: { after: sp(200) },
          };
        case 'sideRule':
          return {
            children: toRuns(runs, { font: nameRunFont }),
            alignment: AlignmentType.LEFT,
            spacing: { after: sp(200) },
            border: { left: sideRuleBorder },
          };
        case 'rule':
        default:
          return {
            children: toRuns(runs, { font: nameRunFont }),
            alignment: AlignmentType.CENTER,
            spacing: { after: sp(200) },
            border: { bottom: nameRule },
          };
      }
    };

    // h2 (section label) paragraph shape per sectionStyle.
    const sectionProps = (runs) => {
      switch (theme.sectionStyle) {
        case 'bracket':
          return {
            children: [
              new TextRun({ text: '[ ', color: accent, font: 'Courier New' }),
              ...toRuns(runs, { uppercase: true, color: accent, font: 'Courier New' }),
              new TextRun({ text: ' ]', color: accent, font: 'Courier New' }),
            ],
            spacing: { before: sp(240), after: sp(100) },
          };
        case 'band':
          return {
            children: toRuns(runs, { uppercase: true, color: reverse }),
            shading: accentShading,
            spacing: { before: sp(240), after: sp(100), line: 320 },
          };
        case 'underline':
        default:
          return {
            children: toRuns(runs, { uppercase: true, color: accent }),
            spacing: { before: sp(240), after: sp(100) },
            border: { bottom: sectionRule },
          };
      }
    };

    const paragraphs = blocks.map((block) => {
      const level = parseInt(block.type.slice(1), 10) || 0;
      if (block.type === 'bullet') {
        return new Paragraph({
          children: toRuns(block.runs),
          bullet: { level: 0 },
          indent: { left: 360, hanging: 360 },
          spacing: { line: sp(264), after: sp(80) },
        });
      }
      if (block.type === 'h1') {
        return new Paragraph({ ...nameProps(block.runs), heading: HeadingLevel.TITLE });
      }
      if (block.type === 'h2') {
        return new Paragraph({ ...sectionProps(block.runs), heading: HeadingLevel.HEADING_1 });
      }
      if (level >= 3) {
        return new Paragraph({
          children: toRuns(block.runs, { color: accent }),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: sp(160), after: sp(80) },
        });
      }
      return new Paragraph({ children: toRuns(block.runs), spacing: { line: sp(264), after: sp(90) } });
    });

    const document = new Document({
      styles: { default: { document: { run: { font: bodyFontFamily, size: 22 } } } },
      sections: [{
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
        children: paragraphs,
      }],
    });
    return Packer.toBlob(document);
  },

  buildPdfBlob(blocks, theme = RESUME_THEMES[0]) {
    const { jsPDF } = jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const marginX = 50;
    const marginBottom = 50;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const maxWidth = pageWidth - marginX * 2;
    const fontSize = { h1: 20, h2: 12.5, h3: 11.5, h4: 11, h5: 10.5, h6: 10, bullet: 10, paragraph: 10 };
    // jsPDF ships exactly three font families (helvetica/times/courier, no
    // embedding) — the closest a hand-rolled canvas-style renderer gets to
    // the nameFont/bodyFont pairing the DOCX/DOM renderers can express in full.
    const nameFontFamily = theme.nameFont === 'serif' ? 'times' : 'helvetica';
    const bodyFontFamily = theme.bodyFont === 'serif' ? 'times' : 'helvetica';
    const accent = this.hexToRgb(theme.accent);
    const faintRule = this.hexToRgb(theme.faint);
    const reverse = [255, 255, 255];
    const ink = [33, 33, 33];
    const scale = DENSITY_SCALE[theme.density] ?? 1;
    const sp = (n) => Math.round(n * scale);
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
    const drawRuns = (runs, { x: startX, width, size, bulletAt, family }) => {
      const lineHeight = size * 1.32 * scale;
      const tokens = [];
      runs.forEach((r) => r.text.split(/(\s+)/).filter(Boolean)
        .forEach((text) => tokens.push({ text, bold: r.bold, italic: r.italic })));

      doc.setFontSize(size);
      ensureSpace(lineHeight);
      if (bulletAt !== undefined) {
        doc.setFont(family, 'normal');
        doc.text('•', bulletAt, y);
      }

      let x = startX;
      tokens.forEach((t) => {
        doc.setFont(family, styleFor(t.bold, t.italic));
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

    // Draws the h1 (name) block per nameStyle. Each branch owns its complete
    // vertical rhythm — text plus any fill/badge/rule chrome plus the gap
    // that carries into the next block — consolidating what the original's
    // shared isHeading branch + its `block.type === 'h1'` tail did, so every
    // style still ends at the equivalent total `y` advance for 'rule'/normal.
    const drawName = (text) => {
      const size = fontSize.h1;
      const lh = size * 1.32;
      doc.setFontSize(size);
      switch (theme.nameStyle) {
        case 'band': {
          doc.setFont(nameFontFamily, 'bold');
          const lines = doc.splitTextToSize(text, maxWidth - 28);
          const padY = 10;
          const blockH = lines.length * lh + padY * 2;
          ensureSpace(blockH);
          doc.setFillColor(...accent);
          doc.rect(marginX - 14, y - lh * 0.8 - padY, maxWidth + 28, blockH, 'F');
          doc.setTextColor(...reverse);
          lines.forEach((line) => { doc.text(line, marginX, y); y += lh; });
          y += sp(22);
          break;
        }
        case 'monogram': {
          doc.setFont(nameFontFamily, 'bold');
          const badge = size * 1.6;
          ensureSpace(badge);
          const bx = marginX;
          const by = y - lh * 0.78;
          doc.setFillColor(...accent);
          doc.roundedRect(bx, by, badge, badge, 6, 6, 'F');
          doc.setFont(bodyFontFamily, 'bold');
          doc.setFontSize(size * 0.5);
          doc.setTextColor(...reverse);
          const initials = this.deriveInitials(text);
          const iw = doc.getTextWidth(initials);
          doc.text(initials, bx + (badge - iw) / 2, by + badge / 2 + size * 0.18);
          doc.setFont(nameFontFamily, 'bold');
          doc.setFontSize(size);
          doc.setTextColor(...accent);
          doc.text(text, bx + badge + 16, y);
          y += lh + sp(22);
          break;
        }
        case 'sideRule': {
          doc.setFont(nameFontFamily, 'bold');
          const lines = doc.splitTextToSize(text, maxWidth - 30);
          const blockH = lines.length * lh;
          ensureSpace(blockH);
          doc.setFillColor(...accent);
          doc.rect(marginX, y - lh * 0.8, 5, blockH, 'F');
          doc.setTextColor(...accent);
          lines.forEach((line) => { doc.text(line, marginX + 17, y); y += lh; });
          y += sp(22);
          break;
        }
        case 'rule':
        default: {
          doc.setFont(nameFontFamily, 'bold');
          doc.setTextColor(...accent);
          doc.splitTextToSize(text, maxWidth).forEach((line) => {
            ensureSpace(lh);
            doc.text(line, marginX, y);
            y += lh;
          });
          y += sp(5) + sp(6);
          rule(accent, 1.1);
          y += sp(16);
        }
      }
    };

    // Draws the h2 (section label) block per sectionStyle — same
    // complete-rhythm-per-branch shape as drawName, just above.
    const drawSectionLabel = (text) => {
      const size = fontSize.h2;
      const lh = size * 1.32;
      doc.setFontSize(size);
      switch (theme.sectionStyle) {
        case 'bracket': {
          doc.setFont('courier', 'bold');
          doc.setTextColor(...accent);
          const display = `[ ${text.toUpperCase()} ]`;
          doc.splitTextToSize(display, maxWidth).forEach((line) => {
            ensureSpace(lh);
            doc.text(line, marginX, y);
            y += lh;
          });
          y += sp(5) + sp(12);
          break;
        }
        case 'band': {
          doc.setFont(bodyFontFamily, 'bold');
          const display = text.toUpperCase();
          const tw = doc.getTextWidth(display);
          const padX = 10;
          const padY = 6;
          const blockH = lh + padY * 2;
          ensureSpace(blockH);
          doc.setFillColor(...accent);
          doc.rect(marginX - padX, y - lh * 0.8 - padY, tw + padX * 2, blockH, 'F');
          doc.setTextColor(...reverse);
          doc.text(display, marginX, y);
          y += lh;
          y += sp(5) + sp(12);
          break;
        }
        case 'underline':
        default: {
          doc.setFont(bodyFontFamily, 'bold');
          doc.setTextColor(...accent);
          const display = text.toUpperCase();
          doc.splitTextToSize(display, maxWidth).forEach((line) => {
            ensureSpace(lh);
            doc.text(line, marginX, y);
            y += lh;
          });
          y += sp(5);
          rule(faintRule, 0.6);
          y += sp(12);
        }
      }
    };

    blocks.forEach((block, i) => {
      const isHeading = block.type.startsWith('h');
      const isBullet = block.type === 'bullet';
      const size = fontSize[block.type] ?? 10;
      const indent = isBullet ? 14 : 0;

      if (isHeading && i > 0) y += sp(10);

      if (block.type === 'h1') {
        drawName(block.runs.map((r) => r.text).join(''));
      } else if (block.type === 'h2') {
        drawSectionLabel(block.runs.map((r) => r.text).join(''));
      } else if (isHeading) {
        const lh = size * 1.32;
        doc.setFontSize(size);
        doc.setFont(bodyFontFamily, 'bold');
        doc.setTextColor(...accent);
        doc.splitTextToSize(block.runs.map((r) => r.text).join(''), maxWidth).forEach((line) => {
          ensureSpace(lh);
          doc.text(line, marginX, y);
          y += lh;
        });
        y += sp(5);
      } else {
        doc.setTextColor(...ink);
        drawRuns(block.runs, {
          x: marginX + indent,
          width: maxWidth - indent,
          size,
          bulletAt: isBullet ? marginX : undefined,
          family: bodyFontFamily,
        });
        y += sp(3);
      }
    });

    return doc.output('blob');
  },

  // Builds a themed on-screen preview of the optimized resume as real DOM
  // nodes — mirrors the visual language of buildDocxBlob/buildPdfBlob, now
  // fully theme-driven rather than fixed: nameStyle/sectionStyle pick
  // modifier classes (the 'rule'/'underline' defaults reproduce the
  // original centered-bordered-name + uppercase-accent-divider look without
  // any modifier, so theme 0 stays exactly what it always rendered),
  // nameFont/bodyFont feed `--rp-name-font`/`--rp-body-font`, and density
  // feeds `--rp-density` — a spacing-only multiplier the CSS consumes via
  // calc() (see DENSITY_SCALE). Each thumbnail still truthfully represents
  // what that card's downloads will look like, across all ten shapes.
  //
  // SECURITY: every fragment of `runs[].text` — ultimately AI-generated /
  // user-influenced content — is inserted via textContent / TextNode only,
  // and elements are composed with createElement/append, never innerHTML or
  // string-concatenated markup. A hostile resume/job payload cannot be
  // parsed as HTML this way. This mirrors the existing `.value`-only rule for
  // #outputArea (see triggerExecutionPipeline) — preserve that posture if you
  // ever touch this. The new monogram badge and bracket/band chrome are pure
  // CSS (modifier classes + ::before/::after content, see index.html) for
  // the same reason — they add zero new text-insertion surface.
  renderResumePreview(blocks, theme) {
    const page = document.createElement('div');
    page.className = 'resume-preview-page';
    page.style.setProperty('--rp-accent', `#${theme.accent}`);
    page.style.setProperty('--rp-faint', `#${theme.faint}`);
    page.style.setProperty('--rp-name-font', FONT_STACKS[theme.nameFont] ?? FONT_STACKS.sans);
    page.style.setProperty('--rp-body-font', FONT_STACKS[theme.bodyFont] ?? FONT_STACKS.sans);
    page.style.setProperty('--rp-density', String(DENSITY_SCALE[theme.density] ?? 1));

    const runNode = (run) => {
      let node = document.createTextNode(run.text);
      if (run.bold) {
        const strong = document.createElement('strong');
        strong.appendChild(node);
        node = strong;
      }
      if (run.italic) {
        const em = document.createElement('em');
        em.appendChild(node);
        node = em;
      }
      return node;
    };
    const appendRuns = (el, runs) => runs.forEach((run) => el.appendChild(runNode(run)));

    blocks.forEach((block) => {
      const level = parseInt(block.type.slice(1), 10) || 0;
      let el;
      if (block.type === 'bullet') {
        el = document.createElement('p');
        el.className = 'rp-bullet';
        const dot = document.createElement('span');
        dot.className = 'rp-dot';
        dot.textContent = '•';
        const body = document.createElement('span');
        appendRuns(body, block.runs);
        el.append(dot, body);
      } else if (block.type === 'h1') {
        el = document.createElement('h1');
        el.className = theme.nameStyle === 'rule' ? 'rp-name' : `rp-name rp-name--${theme.nameStyle}`;
        if (theme.nameStyle === 'monogram') {
          const badge = document.createElement('span');
          badge.className = 'rp-monogram-badge';
          badge.textContent = this.deriveInitials(block.runs.map((r) => r.text).join(''));
          el.appendChild(badge);
        }
        appendRuns(el, block.runs);
      } else if (block.type === 'h2') {
        el = document.createElement('h2');
        el.className = theme.sectionStyle === 'underline' ? 'rp-section' : `rp-section rp-section--${theme.sectionStyle}`;
        appendRuns(el, block.runs);
      } else if (level >= 3) {
        el = document.createElement('h3');
        el.className = 'rp-subhead';
        appendRuns(el, block.runs);
      } else {
        el = document.createElement('p');
        el.className = 'rp-paragraph';
        appendRuns(el, block.runs);
      }
      page.appendChild(el);
    });

    return page;
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
  previewBlocks: null,

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
      previewCards: document.querySelectorAll('.preview-card'),
      previewModal: document.getElementById('previewModal'),
      previewModalBackdrop: document.getElementById('previewModalBackdrop'),
      previewModalPage: document.getElementById('previewModalPage'),
      previewModalLabel: document.getElementById('previewModalLabel'),
      previewModalCloseBtn: document.getElementById('previewModalCloseBtn'),
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

    this.bindPreviewCards();
    this.els.previewModalCloseBtn.addEventListener('click', () => this.closePreviewModal());
    this.els.previewModalBackdrop.addEventListener('click', () => this.closePreviewModal());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.els.previewModal.classList.contains('hidden')) this.closePreviewModal();
    });
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

  // Wires each style-gallery card's zoom/Word/PDF buttons to its theme, looked
  // up by the card's `data-theme-id` (not array position) so the HTML and the
  // RESUME_THEMES list stay in sync even if either gets reordered later.
  bindPreviewCards() {
    this.els.previewCards.forEach((card) => {
      const theme = RESUME_THEMES.find((t) => t.id === card.dataset.themeId);
      if (!theme) return;
      // Whole thumbnail is the preview trigger now (no separate zoom button) —
      // div needs both a click and a keydown handler to behave like a button
      // for keyboard/screen-reader users (role="button" tabindex="0" in the HTML).
      const thumbWrap = card.querySelector('.preview-thumb-wrap');
      thumbWrap.addEventListener('click', () => this.openPreviewModal(theme));
      thumbWrap.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this.openPreviewModal(theme);
      });
      card.querySelector('.preview-word-btn').addEventListener('click', () => this.downloadThemedFile('docx', theme));
      card.querySelector('.preview-pdf-btn').addEventListener('click', () => this.downloadThemedFile('pdf', theme));
    });
  },

  wipeAllData() {
    AppCore.purgeAllLocalState();
    this.els.resume.value = '';
    this.els.job.value = '';
    this.els.output.value = '';
    this.els.model.selectedIndex = 0;
    this.resumeFileBaseName = '';
    this.renderThemePreviews('');
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
      this.renderThemePreviews(result);
    } catch (err) {
      this.els.output.value = `Run failed:\n${err.message}`;
      this.renderThemePreviews('');
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

  // Parses the optimized Markdown into blocks ONCE (cached on `this.previewBlocks`,
  // reused by every card's zoom/Word/PDF action — no need to re-parse 15 times),
  // then (re)draws each gallery card's thumbnail in its own theme. Pass '' to
  // clear the gallery back to its empty state (used on failed runs and on wipe).
  renderThemePreviews(markdown) {
    this.previewBlocks = markdown.trim() ? AppCore.parseMarkdownToBlocks(markdown) : null;
    this.els.previewCards.forEach((card) => {
      const theme = RESUME_THEMES.find((t) => t.id === card.dataset.themeId);
      const thumb = card.querySelector('[data-role="thumb"]');
      if (!theme || !thumb) return;
      thumb.replaceChildren();
      if (this.previewBlocks) thumb.appendChild(AppCore.renderResumePreview(this.previewBlocks, theme));
    });
  },

  openPreviewModal(theme) {
    if (!this.previewBlocks) return;
    this.els.previewModalLabel.textContent = `${theme.label} — quick preview`;
    this.els.previewModalPage.replaceChildren(AppCore.renderResumePreview(this.previewBlocks, theme));
    this.els.previewModal.classList.remove('hidden');
  },

  closePreviewModal() {
    this.els.previewModal.classList.add('hidden');
    this.els.previewModalPage.replaceChildren();
  },

  async downloadThemedFile(format, theme) {
    if (!this.previewBlocks) return;
    try {
      const base = `${this.deriveOutputFilenameBase()}_optimized_${theme.id}`;
      if (format === 'docx') {
        const blob = await AppCore.buildDocxBlob(this.previewBlocks, theme);
        this.triggerDownload(blob, `${base}.docx`);
      } else {
        const blob = AppCore.buildPdfBlob(this.previewBlocks, theme);
        this.triggerDownload(blob, `${base}.pdf`);
      }
    } catch (err) {
      alert('Could not generate that file — copy the Markdown instead.');
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
