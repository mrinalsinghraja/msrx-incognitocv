/**
 * Tests for match.js. No framework, no dependencies — `node tests/match.test.js`.
 *
 * The point of these is that the score is a claim, not a vibe: if "your match
 * went 41 -> 88" is going to appear on screen next to a candidate's real job
 * application, the arithmetic behind it has to be pinned down.
 */

const assert = require('node:assert/strict');
const Match = require('../match.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
}

/* --- Fixtures ------------------------------------------------------------ */

const JOB = `
Senior Vendor Operations Manager

We are looking for a Senior Vendor Operations Manager to own third-party
governance across our shared services centre.

Requirements:
- 7+ years of experience in vendor management within regulated financial services
- Deep knowledge of SOX controls and regulatory reporting
- Advanced SQL and Power BI for operational reporting
- Six Sigma or equivalent process improvement certification
- Experience running supplier due diligence at scale

Nice to have:
- Exposure to ServiceNow
- Familiarity with GDPR
`;

const WEAK_CV = `
Amelia Chen
amelia@example.com | +44 7700 900123 | London

Summary
Operations professional. Worked in financial services since 2017.

Experience
Fidelity Business Services India - Senior Manager
2017 - 2025
- Managed suppliers.
- Did reporting for the leadership team.
- Handled audits.

Education
MBA, IIM Bangalore, 2013
`;

const STRONG_CV = `
# Amelia Chen
amelia@example.com | +44 7700 900123 | London

## Summary
Vendor management lead with nine years in regulated financial services, owning
supplier due diligence and SOX controls for a shared services centre.

## Experience
### Fidelity Business Services India - Senior Manager, Vendor Operations
Sep 2017 - Jun 2025
- Cut supplier due diligence cycle time from 34 days to 11 across 4 teams.
- Ran SOX controls testing for 120 vendors with zero material findings in 6 cycles.
- Built the regulatory reporting pack in SQL and Power BI used at quarterly board review.
- Led Six Sigma process improvement across third-party governance, saving 2,400 hours.

## Education
### MBA, Operations - IIM Bangalore
2011 - 2013

## Skills
Vendor management, SOX, regulatory reporting, SQL, Power BI, Six Sigma, ServiceNow, GDPR
`;

/* --- Determinism --------------------------------------------------------- */

test('same input produces an identical report every run', () => {
  const a = Match.analyze(WEAK_CV, JOB, STRONG_CV);
  const b = Match.analyze(WEAK_CV, JOB, STRONG_CV);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

/* --- Keyword extraction -------------------------------------------------- */

test('pulls the posting\'s hard requirements out as keywords', () => {
  const terms = Match.extractKeywords(JOB).map((k) => k.term);
  const joined = terms.join(' | ');
  ['sox', 'sql', 'power bi', 'six sigma', 'due diligence'].forEach((needle) => {
    assert.ok(joined.includes(needle), `expected "${needle}" among keywords, got: ${joined}`);
  });
});

test('drops boilerplate that appears in every posting', () => {
  const terms = Match.extractKeywords(JOB).map((k) => k.term);
  ['requirements', 'experience', 'looking', 'years', 'candidate'].forEach((noise) => {
    assert.ok(!terms.includes(noise), `"${noise}" should have been filtered as boilerplate`);
  });
});

test('caps the list so the gap report stays actionable', () => {
  assert.ok(Match.extractKeywords(JOB).length <= 40);
  assert.equal(Match.extractKeywords(JOB, { limit: 5 }).length, 5);
});

test('keeps technical tokens that punctuation-stripping usually destroys', () => {
  const kws = Match.extractKeywords('Requirements:\n- Strong C++ and .NET and Node.js and CI/CD');
  const terms = kws.map((k) => k.term).join(' ');
  assert.ok(terms.includes('c++'), `c++ was lost: ${terms}`);
  assert.ok(terms.includes('.net') || terms.includes('net'), `.net was lost: ${terms}`);
});

test('weights requirement-section terms above prose terms', () => {
  const kws = Match.extractKeywords(JOB);
  // "sox" may survive as the phrase "sox controls" — the dedup step drops a
  // unigram once a higher-ranked phrase already covers it, which is correct.
  const sox = kws.find((k) => k.key.split(' ').includes('sox'));
  const centre = kws.find((k) => k.term.includes('shared services'));
  assert.ok(sox, `sox should be extracted, got: ${kws.map((k) => k.term).join(' | ')}`);
  if (centre) assert.ok(sox.weight > centre.weight, 'requirement terms should outweigh prose terms');
});

/* --- Scoring ------------------------------------------------------------- */

test('a CV that names the requirements scores far above one that does not', () => {
  const kws = Match.extractKeywords(JOB);
  const weak = Match.scoreResume(WEAK_CV, kws).score;
  const strong = Match.scoreResume(STRONG_CV, kws).score;
  assert.ok(weak < 40, `weak CV scored ${weak}, expected under 40`);
  assert.ok(strong > 60, `strong CV scored ${strong}, expected over 60`);
  assert.ok(strong - weak > 25, `expected a clear gap, got ${weak} -> ${strong}`);
});

test('score is bounded 0-100', () => {
  const kws = Match.extractKeywords(JOB);
  assert.equal(Match.scoreResume('', kws).score, 0);
  const perfect = Match.scoreResume(kws.map((k) => k.term).join(' '), kws).score;
  assert.ok(perfect >= 90 && perfect <= 100, `saturated CV scored ${perfect}`);
});

test('a same-field CV earns partial credit rather than a bare zero', () => {
  // A flat 0 on a CV that is plainly in the right industry reads as a broken
  // scorer, not as feedback. Near-misses have to pay out something.
  const score = Match.analyze(WEAK_CV, JOB).before.score;
  assert.ok(score > 0, 'a CV sharing the posting\'s field should not score 0');
  assert.ok(score < 35, `partial credit must stay partial, got ${score}`);
});

test('partial matches are labelled so the UI can rank exact gaps first', () => {
  const kws = Match.extractKeywords(JOB);
  const scored = Match.scoreResume(WEAK_CV, kws);
  scored.partial.forEach((p) => assert.equal(p.partial, true));
  // Exact gaps come before near-misses in the list the panel renders.
  const firstPartialIndex = scored.missing.findIndex((m) => m.partial);
  const lastExactIndex = scored.missing.reduce((acc, m, i) => (m.partial ? acc : i), -1);
  if (firstPartialIndex !== -1 && lastExactIndex !== -1) {
    assert.ok(lastExactIndex < firstPartialIndex, 'exact gaps must precede partial ones');
  }
});

test('sub-phrases of a kept phrase are not listed as separate gaps', () => {
  const terms = Match.extractKeywords(JOB).map((k) => k.key);
  terms.forEach((a) => {
    terms.forEach((b) => {
      if (a === b) return;
      assert.ok(!` ${a} `.includes(` ${b} `), `"${b}" is contained in "${a}" and should have been deduped`);
    });
  });
});

test('matching survives plural and tense differences', () => {
  const kws = Match.extractKeywords('Requirements:\n- Managing vendor relationships and supplier audits');
  const hit = Match.scoreResume('I manage vendor relationship and supplier audit work', kws);
  assert.ok(hit.score > 50, `stemming failed, scored ${hit.score}`);
});

test('missing terms come back ranked by how much they would move the score', () => {
  const report = Match.analyze(WEAK_CV, JOB);
  const gaps = report.topGaps;
  assert.ok(gaps.length > 0);
  for (let i = 1; i < gaps.length; i += 1) {
    assert.ok(gaps[i - 1].weight >= gaps[i].weight, 'gaps must be sorted by weight descending');
  }
});

/* --- Before / after ------------------------------------------------------ */

test('reports the delta and only credits genuinely new terms', () => {
  const report = Match.analyze(WEAK_CV, JOB, STRONG_CV);
  assert.ok(report.delta > 0, `expected a positive delta, got ${report.delta}`);
  assert.equal(report.delta, report.after.score - report.before.score);
  report.gained.forEach((g) => {
    assert.ok(!report.before.matched.some((b) => b.key === g.key),
      `"${g.term}" was already present before the rewrite and must not be counted as gained`);
  });
});

test('no optimized text means no after-score rather than a fake one', () => {
  const report = Match.analyze(WEAK_CV, JOB);
  assert.equal(report.after, null);
  assert.equal(report.delta, null);
  assert.equal(report.structure, null);
  assert.ok(report.before.score >= 0);
});

/* --- Seniority ----------------------------------------------------------- */

test('reads the required years out of a posting', () => {
  assert.equal(Match.detectYearsRequired('We need 7+ years of experience'), 7);
  assert.equal(Match.detectYearsRequired('Minimum of five years in the field'), 5);
  assert.equal(Match.detectYearsRequired('3 to 5 years preferred'), 3);
  assert.equal(Match.detectYearsRequired('No stated requirement'), null);
});

test('ignores impossible year counts', () => {
  assert.equal(Match.detectYearsRequired('99 years of experience'), null);
});

test('reads seniority from the title area, not the whole document', () => {
  assert.equal(Match.detectLevel('Head of Vendor Operations').name, 'Leadership');
  assert.equal(Match.detectLevel('Senior Manager, Operations').name, 'Senior');
  assert.equal(Match.detectLevel('Graduate Analyst Programme').name, 'Mid');
  assert.equal(Match.detectLevel('Nothing identifiable here').name, 'Unspecified');
});

test('flags a shortfall against the posting\'s stated years', () => {
  const cmp = Match.compareLevel('Worked from 2021 to 2025 as an analyst', JOB);
  assert.equal(cmp.yearsRequired, 7);
  assert.equal(cmp.yearsHave, 4);
  assert.equal(cmp.yearsShortfall, 3);
});

test('does not invent a shortfall when the CV has no dates', () => {
  const cmp = Match.compareLevel('Senior manager with vendor experience', JOB);
  assert.equal(cmp.yearsHave, null);
  assert.equal(cmp.yearsShortfall, null);
});

/* --- Structure audit ----------------------------------------------------- */

test('passes a well-formed resume', () => {
  const audit = Match.auditStructure(STRONG_CV);
  assert.equal(audit.passed, true, `unexpected failures: ${JSON.stringify(audit.findings)}`);
  assert.ok(audit.stats.bullets >= 4);
  assert.ok(audit.stats.quantified >= 3);
});

test('catches the parse-breaking constructs', () => {
  const withTable = `# A B\na@b.com\n\n| Role | Year |\n| --- | --- |\n| Dev | 2020 |`;
  const labels = Match.auditStructure(withTable).findings.map((f) => f.label);
  assert.ok(labels.includes('Table detected'));
  assert.equal(Match.auditStructure(withTable).passed, false);

  const withImage = `# A B\na@b.com\n\n![headshot](me.png)`;
  assert.ok(Match.auditStructure(withImage).findings.some((f) => f.label === 'Image detected'));
});

test('catches a missing name and a missing contact line', () => {
  const labels = Match.auditStructure('Some text with no header at all').findings.map((f) => f.label);
  assert.ok(labels.includes('No name heading'));
  assert.ok(labels.includes('No contact line'));
});

test('flags bullets with no numbers in them', () => {
  const vague = `# A B\na@b.com\n\n## Experience\n- Did things\n- Did other things\n- Managed stuff\n- Helped out`;
  assert.ok(Match.auditStructure(vague).findings.some((f) => f.label === 'Few quantified bullets'));
});

test('every finding tells the reader what to do about it', () => {
  const audit = Match.auditStructure('nothing here');
  audit.findings.forEach((f) => {
    assert.ok(f.detail && f.detail.length > 20, `finding "${f.label}" has no actionable detail`);
    assert.ok(['fail', 'warn'].includes(f.level));
  });
});

/* --- Robustness ---------------------------------------------------------- */

test('survives empty, null and junk input without throwing', () => {
  [undefined, null, '', '   ', '\n\n\n', '%%%%%', 'x'.repeat(50000)].forEach((junk) => {
    assert.doesNotThrow(() => Match.analyze(junk, junk, junk), `threw on ${JSON.stringify(String(junk).slice(0, 12))}`);
  });
  assert.equal(Match.analyze('', '').before.score, 0);
});

test('does not mutate its inputs', () => {
  const job = String(JOB);
  const cv = String(WEAK_CV);
  Match.analyze(cv, job, STRONG_CV);
  assert.equal(job, JOB);
  assert.equal(cv, WEAK_CV);
});

/* --- Report -------------------------------------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} failing, ${passed} passing\n`);
  failures.forEach(({ name, err }) => {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message.split('\n')[0]}`);
  });
  process.exit(1);
}
console.log(`${passed} passing`);
