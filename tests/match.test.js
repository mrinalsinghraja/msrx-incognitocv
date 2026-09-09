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

/* --- Noise in the gap list ----------------------------------------------- */

/*
 * Every case below was observed on the live site against a candidate who is a
 * genuine fit. They are grouped because they share one failure mode: the gap
 * list is advice, and advice that names something unactionable ("add 'acme
 * supply co' to your CV") or something the candidate already has is worse than
 * no advice at all.
 */

const HEADED_JOB = `Vendor Operations Manager — Acme Supply Co, Bengaluru

We are hiring a Vendor Operations Manager to own supplier onboarding, contract
compliance and cost recovery across a growing vendor base.

Responsibilities
- Own end-to-end supplier onboarding and vendor lifecycle management
- Drive contract compliance and manage renewals and SLAs
- Build dashboards and reporting in Power BI and SQL
- Run quarterly business reviews with strategic suppliers

Requirements
- 6+ years in vendor operations, procurement or supply chain
- Advanced Excel; SQL and Power BI preferred
- Experience with ERP systems such as SAP Ariba or Coupa`;

const terms = (job) => Match.extractKeywords(job).map((k) => k.term);

test('the hiring company is never a requirement', () => {
  const found = terms(HEADED_JOB);
  ['acme', 'acme supply co', 'manager acme supply', 'supply co bengaluru']
    .forEach((junk) => assert.ok(!found.includes(junk), `"${junk}" should not be a requirement`));
});

test('the posting location is never a requirement', () => {
  assert.ok(!terms(HEADED_JOB).includes('bengaluru'));
});

test('an industry word inside the company name survives', () => {
  // "Acme Supply Co" must not cost the posting its real "supply chain" line.
  assert.ok(terms(HEADED_JOB).includes('supply chain'));
});

test('a company legal suffix is not a term on its own', () => {
  assert.ok(!terms(HEADED_JOB).includes('co'));
});

test('a responsibility verb is dropped and its requirement kept', () => {
  const found = terms(HEADED_JOB);
  assert.ok(!found.includes('drive contract compliance'), 'verb phrase should go');
  assert.ok(!found.includes('drive'), 'bare verb should go');
  assert.ok(!found.includes('build dashboards'));
  assert.ok(found.includes('contract compliance'), 'the requirement itself should stay');
});

test('phrases do not cross a clause boundary', () => {
  const found = terms(HEADED_JOB);
  // "supplier onboarding, contract compliance" is two requirements, not one
  // phrase; no CV will ever contain the run that spans the comma.
  ['supplier onboarding contract', 'onboarding contract compliance']
    .forEach((junk) => assert.ok(!found.includes(junk), `"${junk}" spans a comma`));
});

test('node.js and ci/cd survive clause splitting', () => {
  const found = terms('Requirements\n- Strong node.js and ci/cd experience');
  assert.ok(found.includes('node.js'), 'a dotted token must not be split');
  assert.ok(found.includes('ci/cd'), 'a slashed token must not be split');
});

/* --- Acronyms ------------------------------------------------------------ */

test('an acronym in the CV matches its long form in the posting', () => {
  const job = 'Requirements\n- Run quarterly business reviews with suppliers';
  const cv = 'Owned supplier scorecards and QBRs every quarter.';
  const gaps = Match.scoreResume(cv, Match.extractKeywords(job)).missing.map((m) => m.term);
  assert.ok(!gaps.includes('quarterly business reviews'), 'QBRs is the same thing');
});

test('the long form in the CV matches an acronym in the posting', () => {
  const job = 'Requirements\n- Own the SLA framework';
  const cv = 'Owned the service level agreement framework end to end.';
  assert.equal(Match.scoreResume(cv, Match.extractKeywords(job)).missing.length, 0);
});

test('an unrelated acronym is still reported missing', () => {
  const job = 'Requirements\n- Own the SLA framework';
  const cv = 'Ran quarterly business reviews.';
  assert.ok(Match.scoreResume(cv, Match.extractKeywords(job)).missing.length > 0);
});

/* --- Years of experience ------------------------------------------------- */

const thisYear = new Date().getFullYear();

test('an open-ended current role counts to today', () => {
  // The bug: max-minus-min over four-digit years stopped at the last year
  // TYPED, so a career running to "present" was truncated. It under-counted
  // every currently-employed candidate, and the number is shown as a verdict.
  const years = Match.estimateYearsExperience('Analyst 2014-2017\nManager 2017-present');
  assert.equal(years, thisYear - 2014);
});

test('"current" and "to date" read the same as "present"', () => {
  assert.equal(Match.estimateYearsExperience('Joined 2015 — current'), thisYear - 2015);
  assert.equal(Match.estimateYearsExperience('Manager, 2015 to date'), thisYear - 2015);
});

test('a closed date range is still measured end to end', () => {
  assert.equal(Match.estimateYearsExperience('Analyst 2010-2014\nManager 2014-2018'), 8);
});

test('a single year with no end date yields nothing', () => {
  assert.equal(Match.estimateYearsExperience('Graduated 2016'), null);
});

test('a currently-employed CV is not reported as under-experienced', () => {
  const level = Match.compareLevel('Manager, Northwind, 2014-present', 'Requirements\n- 6+ years required');
  assert.equal(level.yearsShortfall, 0);
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
