/**
 * MSRX IncognitoCV — match engine.
 * ---------------------------------------------------------------------------
 * Deterministic, dependency-free analysis of a CV against a job posting.
 *
 * WHY THIS RUNS IN THE BROWSER
 * The paid tools this competes with (Jobscan, Teal, Rezi) all require you to
 * upload your resume to their servers to get a match score. This module is the
 * same class of analysis with zero network calls: the scoring is arithmetic on
 * text, not inference, so it runs locally, instantly, for free, and your CV
 * never leaves the machine. That is the product's whole pitch made literal.
 *
 * It is also deliberately NOT an AI call. A score that changes when you re-run
 * it is not a score. Everything here is a pure function of its inputs — same
 * text in, same number out, every time — which is what makes it testable
 * (tests/match.test.js) and what makes "your score went 41 -> 88" a claim
 * rather than a vibe.
 *
 * Loaded as a classic script alongside core.js (CSP is `script-src 'self'`),
 * with a CommonJS guard at the bottom so the same file runs under node in
 * tests. No build step.
 */

const MatchEngine = (() => {
  'use strict';

  /* --- Lexicon ----------------------------------------------------------- */

  // Ordinary English + resume/JD boilerplate. Boilerplate matters as much as
  // grammar words here: "responsibilities", "candidate" and "opportunity"
  // appear in every posting ever written and carry no matching signal.
  const STOPWORDS = new Set(`
    a about above after again against all am an and any are aren't as at be because been before being
    below between both but by can cannot could couldn't did didn't do does doesn't doing don't down during
    each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself
    his how i if in into is isn't it its itself let's me more most mustn't my myself no nor not of off on
    once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such
    than that the their theirs them themselves then there these they this those through to too under until
    up very was wasn't we were weren't what when where which while who whom why with won't would wouldn't
    you your yours yourself yourselves will shall may might must also across within upon per via etc
    role roles job jobs position positions candidate candidates applicant applicants opportunity
    opportunities responsibility responsibilities requirement requirements qualification qualifications
    duties duty description descriptions company companies organisation organization organizations team
    teams work working works experience experienced years year month months day days time full part
    ability able strong excellent good great proven demonstrated solid successful successfully
    including include includes included ensure ensuring ensures provide providing provides provided
    support supporting supports supported help helping helps new preferred required desirable plus
    bonus nice must-have looking seeking join us we're our you'll you're apply application applications
    please contact email send resume cv cover letter salary benefits location remote hybrid onsite
    office based level senior junior mid entry lead head chief officer
    deep advanced extensive knowledge familiar familiarity exposure equivalent understanding
    hands-on expertise background track record highly ideally ideal typically
  `.trim().split(/\s+/));

  // Terms that are worth more when they match, because an ATS keyword filter
  // is far likelier to be keyed on a named tool, standard or credential than
  // on a verb. Not exhaustive by design — the heuristics below catch the long
  // tail (anything with a digit, dot, plus, hash, or a 2-5 letter all-caps
  // acronym), so this list only needs to cover common terms those miss.
  const HARD_SKILL_HINTS = new Set([
    'python','java','javascript','typescript','ruby','golang','rust','kotlin','swift','scala','php','perl',
    'react','angular','vue','svelte','django','flask','rails','spring','laravel','express','nextjs',
    'node','deno','graphql','rest','grpc','kafka','rabbitmq','redis','elasticsearch','kubernetes','docker',
    'terraform','ansible','jenkins','gitlab','github','bitbucket','airflow','spark','hadoop','snowflake',
    'databricks','tableau','looker','powerbi','excel','sheets','sql','nosql','postgres','postgresql',
    'mysql','mongodb','dynamodb','oracle','sap','salesforce','servicenow','workday','netsuite','hubspot',
    'jira','confluence','asana','monday','smartsheet','sharepoint','figma','sketch','photoshop','illustrator',
    'agile','scrum','kanban','safe','waterfall','prince2','pmp','itil','lean','sigma','kaizen','devops',
    'cicd','sre','observability','grafana','prometheus','datadog','splunk','sentry',
    'gdpr','hipaa','sox','pci','iso','soc2','kyc','aml','basel','ifrs','gaap','fcpa',
    'cfa','cpa','acca','cima','frm','cissp','cisa','cism','ceh','csm','cspo',
    'forecasting','budgeting','reconciliation','underwriting','actuarial','payroll','recruitment',
    'onboarding','compensation','benefits','erp','crm','ehr','emr','plm','mrp','wms','tms',
    'seo','sem','ppc','cro','saas','b2b','b2c','p&l','kpi','okr','sla','rfp','rfi','sow','msa','nda',
  ]);

  // Section headings that mark the part of a posting an ATS filter is built
  // from. Terms inside these get a multiplier — "5 years of Python" under
  // REQUIREMENTS is a screening gate; the same phrase in a culture blurb is not.
  const REQUIREMENT_HEADINGS = /(requirement|qualification|must[\s-]?have|skills?|experience|competenc|you (will )?(have|bring)|what (you|we).{0,20}(need|look)|essential|technical)/i;

  const WEIGHT = {
    requirementSection: 2.0,   // named in the screening criteria
    leadParagraph: 1.5,        // title + opening summary
    hardSkill: 1.6,            // a named tool, standard or credential
    phraseBonus: 1.25,         // multi-word terms are more specific than single
  };


  // Verbs that open a responsibility bullet. The requirement is the noun phrase
  // that follows: a posting saying "drive contract compliance" is asking for
  // contract compliance, and a CV that says "contract compliance" HAS it. Left
  // in, the verb both manufactures gaps nobody can close ("build dashboards")
  // and hides real matches behind a word no CV repeats verbatim.
  // Stored as stems, because that is what they are compared against: stem()
  // takes "drive" to "driv" and "coordinating" to "coordinat", so a set of
  // dictionary spellings would silently never match. `stem` is a hoisted
  // function declaration, so calling it here at module init is fine.
  const RESPONSIBILITY_VERBS = new Set(`
    own drive lead build run manage handle oversee coordinate execute deliver develop create
    design define establish implement maintain monitor track report analyse analyze review
    prepare produce conduct perform partner collaborate grow scale champion spearhead
    contribute participate assist facilitate enable optimise optimize improve hiring seeking
  `.trim().split(/\s+/).map(stem));

  // Company legal forms. The most reliable marker of a company name in prose.
  const COMPANY_SUFFIX = /(?:co|corp|corporation|inc|ltd|limited|llc|llp|plc|gmbh|pvt|private|ag|sa|bv|nv|group|holdings|technologies|technology|solutions|systems|labs|partners|ventures|industries)/;

  const MAX_KEYWORDS = 40;


  /* --- Text utilities ---------------------------------------------------- */

  // Keeps the characters that carry meaning inside real technical tokens:
  // c++, c#, .net, node.js, ci/cd, p&l. Stripping these is the classic way a
  // naive tokenizer turns "C++" into "c" and reports a false match.
  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[‘’“”]/g, "'")
      .replace(/[^a-z0-9+#./&\-\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Deliberately crude suffix stripping, applied to BOTH sides of every
  // comparison. A real stemmer would be more accurate in isolation but would
  // introduce a dependency and a second source of truth; symmetric crudeness
  // is enough to match "manage/manages/managed/managing" and "report/reports".
  function stem(token) {
    if (token.length <= 4) return token;
    const stripped = token
      .replace(/(ational|ization|isation)$/, '')
      .replace(/(ements?|ments?)$/, '')
      .replace(/(ings?|ers?|ed|es|s)$/, '');
    // Drop a trailing silent 'e' too, otherwise "manage" and "managing" stem to
    // "manage" and "manag" and never match — the exact miss that makes a
    // keyword report look broken to anyone who reads it carefully.
    return stripped.length > 4 ? stripped.replace(/e$/, '') : stripped;
  }

  function tokenize(text) {
    return normalize(text)
      .split(' ')
      // Trailing punctuation is sentence grammar, not part of the term:
      // "centre." must equal "centre". Leading marks stay so ".net" survives,
      // and '+'/'#' are never stripped so "c++" and "c#" survive.
      .map((t) => t.replace(/[.\-/&]+$/, ''))
      .filter(Boolean);
  }

  /**
   * Splits a line at clause boundaries before n-grams are taken from it.
   *
   * normalize() turns punctuation into spaces, so "supplier onboarding,
   * contract compliance and cost recovery" was one flat token run and the
   * windows crossed the comma: "supplier onboarding contract" and "onboarding
   * contract compliance" both became requirements, though neither is a phrase
   * anyone wrote or will ever match verbatim.
   *
   * Splits on commas, semicolons, colons, bullets, pipes, spaced dashes and
   * sentence-ending periods — never on a bare period or slash, which would
   * take "node.js" and "ci/cd" apart.
   */
  function clauses(line) {
    return String(line || '')
      .split(/[,;:•|]|\s+[-–—]\s+|\.(?=\s|$)/)
      .map((c) => c.trim())
      .filter(Boolean);
  }

  function isNoiseToken(token) {
    if (!token) return true;
    if (STOPWORDS.has(token)) return true;
    if (token.length < 2) return true;
    if (/^[0-9.+#\-/&]+$/.test(token)) return true;   // bare numbers and symbols
    // A company's legal form, stranded by the employer filter above. "co" and
    // "ltd" are grammar in a company name, never something a CV lacks.
    if (new RegExp(`^${COMPANY_SUFFIX.source}$`).test(token)) return true;
    return false;
  }

  // The long tail of hard skills: anything a curated list will always miss.
  function looksTechnical(term) {
    if (HARD_SKILL_HINTS.has(term)) return true;
    if (/[0-9]/.test(term) && /[a-z]/.test(term)) return true;   // s3, ec2, iso27001
    if (/[+#]/.test(term)) return true;                          // c++, c#
    if (/\.[a-z]{2,4}$/.test(term)) return true;                 // node.js, .net
    if (/^[a-z]{2,5}$/.test(term) && !STOPWORDS.has(term) && term === term.toUpperCase()) return true;
    return false;
  }

  /* --- Section detection ------------------------------------------------- */

  /**
   * Splits a posting into lines and marks which ones fall under a
   * requirements-style heading. Runs on the ORIGINAL text, not the normalized
   * form, because heading detection needs the line breaks and capitalisation.
   */
  function markRequirementLines(text) {
    const lines = String(text || '').split(/\r?\n/);
    const marks = new Array(lines.length).fill(false);
    let inRequirements = false;

    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // A heading is a short line — long prose that happens to contain the word
      // "requirements" is not a section break.
      const isHeadingish = trimmed.length > 0 && trimmed.length < 80 &&
        (/[:：]$/.test(trimmed) || trimmed === trimmed.toUpperCase() || /^#{1,4}\s/.test(trimmed) || /^[-*•]?\s*\*\*/.test(trimmed));

      if (isHeadingish) inRequirements = REQUIREMENT_HEADINGS.test(trimmed);
      marks[i] = inRequirements;
    });

    return { lines, marks };
  }

  /* --- The hiring company itself ----------------------------------------- */

  /**
   * Finds the employer's own name and location in a posting.
   *
   * Neither can ever be something a CV is "missing" — nobody lists the company
   * they are applying to as a skill — yet both score highly: they are
   * multi-word (so they collect the phrase bonus) and they sit in the title
   * line (so they collect the lead-paragraph multiplier). Unfiltered, a gap
   * list for "Vendor Operations Manager - Acme Supply Co, Bengaluru" opens with
   * "acme supply co", "manager acme supply" and "supply co bengaluru", and the
   * three terms that would actually help are pushed below the fold.
   *
   * Returns { name: [tokens], places: Set(tokens) }, both normalized+stemmed.
   */
  function detectEmployer(jobText) {
    const text = String(jobText || '');
    const seq = (str) => tokenize(str).map(stem).filter(Boolean);
    let name = [];
    const places = new Set();

    // Strongest signal: the header line, written "Title - Company, Location".
    const header = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
    const dashSplit = header.split(/\s+[-–—]\s+/);
    if (dashSplit.length > 1) {
      const tail = dashSplit[dashSplit.length - 1].split(',');
      name = seq(tail[0]);
      // Everything after the company is where the job is, not what it needs.
      tail.slice(1).forEach((part) => seq(part).forEach((t) => places.add(t)));
    }

    // Fall back to prose: a legal suffix, or "at X" / "join X" / "X is hiring".
    if (!name.length) {
      const suffixed = text.match(new RegExp(
        String.raw`\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3}\s+` + COMPANY_SUFFIX.source + String.raw`)\b`, 'i'));
      const phrased = text.match(/\b(?:at|join|about)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})/);
      const hiring = text.match(/\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})\s+is\s+(?:hiring|looking|seeking)/);
      const found = (suffixed && suffixed[1]) || (hiring && hiring[1]) || (phrased && phrased[1]);
      if (found) name = seq(found);
    }

    return { name, places };
  }

  /**
   * True when a candidate term is really the employer's name or address.
   *
   * Two consecutive tokens, not one, because a company name routinely borrows
   * an industry word — "Acme Supply Co" must not cost the posting its genuine
   * "supply chain" requirement. A place name is dropped outright: a city is
   * never a skill, so there is no such collision to protect against.
   */
  function isEmployerTerm(keyTokens, employer, requirementTokens) {
    if (keyTokens.some((t) => employer.places.has(t)) && keyTokens.every((t) => !looksTechnical(t))) return true;
    const name = employer.name;
    if (!name.length) return false;

    // A one-word company name cannot be caught by the pair rule, and splitting
    // the header at its punctuation is what strands it as a bare token. The
    // discriminator is where else it appears: a real requirement is stated
    // under the requirements heading, whereas the employer's own name occurs
    // only in the letterhead. So "Acme" goes and "Supply" — which the posting
    // also uses in "supply chain" — stays.
    if (keyTokens.length === 1) {
      const t = keyTokens[0];
      return name.includes(t) && !looksTechnical(t) && !requirementTokens.has(t);
    }

    for (let i = 0; i + 1 < keyTokens.length; i += 1) {
      for (let j = 0; j + 1 < name.length; j += 1) {
        if (keyTokens[i] === name[j] && keyTokens[i + 1] === name[j + 1]) return true;
      }
    }
    return false;
  }

  /* --- Keyword extraction ------------------------------------------------ */

  /**
   * Pulls the terms a screening system would plausibly key on out of a job
   * posting, weighted by how much each one matters.
   *
   * Returns [{ term, weight, hard, phrase }] sorted by weight, capped at
   * MAX_KEYWORDS — a 200-item list is not advice, it is noise.
   */
  function extractKeywords(jobText, options = {}) {
    const limit = options.limit || MAX_KEYWORDS;
    const { lines, marks } = markRequirementLines(jobText);
    const leadCutoff = Math.max(1, Math.floor(lines.length * 0.15));
    const employer = detectEmployer(jobText);
    // Tokens stated under a requirements heading — the evidence that a word is
    // a real requirement and not just part of the employer's letterhead.
    const requirementTokens = new Set();
    lines.forEach((line, i) => {
      if (marks[i]) tokenize(line).map(stem).forEach((t) => requirementTokens.add(t));
    });

    const scores = new Map();   // stemmed key -> { term, weight, hard, phrase }

    lines.forEach((line, lineIndex) => {
      let positional = 1;
      if (marks[lineIndex]) positional *= WEIGHT.requirementSection;
      if (lineIndex < leadCutoff) positional *= WEIGHT.leadParagraph;

      clauses(line).forEach((clause) => {
      const tokens = tokenize(clause);
      if (!tokens.length) return;

      // Unigrams, bigrams, trigrams. Phrases are scored as one term so
      // "project management" is not double-counted as two unigrams.
      for (let n = 1; n <= 3; n += 1) {
        for (let i = 0; i + n <= tokens.length; i += 1) {
          const parts = tokens.slice(i, i + n);

          // No stopword anywhere in a phrase, not merely at the edges. Allowing
          // interior stopwords is what produces gap lists full of "knowledge of
          // sox", "sigma or equivalent" and "exposure to servicenow" — phrases
          // no CV will ever contain verbatim, which silently drags the score
          // down and buries the terms that actually matter.
          if (parts.some(isNoiseToken)) continue;
          if (parts.some((p) => p.length < 2)) continue;

          // Drop the verb and keep the requirement. The shorter window without
          // it is generated by this same loop, and containment dedup keeps the
          // longest survivor — so skipping here is what lets "contract
          // compliance" through in place of "drive contract compliance".
          //
          // Applied at every length, not just phrases: once the phrases are
          // skipped the bare verbs are what rank, and "add 'drive' to your CV"
          // is not advice.
          if (RESPONSIBILITY_VERBS.has(stem(parts[0]))) continue;

          const term = parts.join(' ');
          const canon = expandAcronyms(parts);
          const key = canon.map(stem).join(' ');
          if (isEmployerTerm(key.split(' '), employer, requirementTokens)) continue;
          const hard = parts.some(looksTechnical);

          let weight = positional;
          if (hard) weight *= WEIGHT.hardSkill;
          if (n > 1) weight *= WEIGHT.phraseBonus;

          const existing = scores.get(key);
          if (existing) {
            // Repetition is signal, but with diminishing returns — a term
            // repeated 20 times is not 20x more important than one repeated
            // twice, it is usually just a boilerplate word.
            existing.weight += weight / (1 + Math.log(1 + existing.hits));
            existing.hits += 1;
          } else {
            scores.set(key, { key, term, weight, hits: 1, hard, phrase: canon.length > 1 });
          }
        }
      }
      });
    });

    const ranked = Array.from(scores.values()).sort((a, b) => b.weight - a.weight);

    // Relative floor. An absolute cap alone still lets a long posting pad the
    // list with incidental terms that carry a twentieth of the top term's
    // weight; those cannot move the score meaningfully but they do dilute it.
    const ceiling = ranked.length ? ranked[0].weight : 0;
    const floor = ceiling * 0.12;

    // Containment dedup. Every n-gram window generates its own sub-windows, so
    // one requirement line yields "process improvement certification",
    // "improvement certification", "process improvement" and "certification" as
    // four separate entries. Left in, the gap list reads as four things to fix
    // when it is one, and the score double-counts the same requirement.
    //
    // The rule: keep the longest phrase, drop anything it fully contains as a
    // contiguous token run. Longest-first ordering makes one pass sufficient.
    const eligible = ranked.filter((e) => e.weight >= floor);
    const byLength = eligible.slice().sort((a, b) => {
      const lenDiff = b.key.split(' ').length - a.key.split(' ').length;
      return lenDiff !== 0 ? lenDiff : b.weight - a.weight;
    });

    const survivors = new Set();
    const claimed = [];
    for (const entry of byLength) {
      const padded = ` ${entry.key} `;
      if (claimed.some((c) => c.includes(padded))) continue;
      claimed.push(padded);
      survivors.add(entry.key);
    }

    // Re-emit in weight order — the caller renders these as a ranked list of
    // what to fix first, so ordering by importance is part of the contract.
    return eligible.filter((e) => survivors.has(e.key)).slice(0, limit);
  }

  /* --- Scoring ----------------------------------------------------------- */

  /**
   * Business shorthand and its long form, in both directions.
   *
   * A CV that says "ran QBRs with strategic suppliers" scores zero against a
   * posting that asks for "quarterly business reviews", and the term lands in
   * the gap list telling the candidate to add something they already have.
   * That is worse than a missed match: it is wrong advice. CVs compress to the
   * acronym and postings spell it out, so the mismatch is the common case, not
   * the edge one.
   */
  const ACRONYMS = new Map([
    ['qbr', 'quarterly business review'],
    ['sla', 'service level agreement'],
    ['kpi', 'key performance indicator'],
    ['okr', 'objective and key result'],
    ['rfp', 'request for proposal'],
    ['rfi', 'request for information'],
    ['sow', 'statement of work'],
    ['msa', 'master service agreement'],
    ['nda', 'non disclosure agreement'],
    ['po', 'purchase order'],
    ['erp', 'enterprise resource planning'],
    ['crm', 'customer relationship management'],
    ['ats', 'applicant tracking system'],
    ['sop', 'standard operating procedure'],
    ['bi', 'business intelligence'],
    ['etl', 'extract transform load'],
    ['uat', 'user acceptance testing'],
    ['qa', 'quality assurance'],
    ['ap', 'accounts payable'],
    ['ar', 'accounts receivable'],
    ['ma', 'mergers and acquisitions'],
    ['kyc', 'know your customer'],
    ['aml', 'anti money laundering'],
    ['ld', 'learning and development'],
    ['capex', 'capital expenditure'],
    ['opex', 'operating expenditure'],
    ['cicd', 'continuous integration and continuous delivery'],
    ['seo', 'search engine optimisation'],
    ['tat', 'turnaround time'],
  ]);

  /**
   * Rewrites acronyms to their long form, on whichever side used the shorthand.
   *
   * Canonicalising BOTH sides is what makes this work. The first attempt bolted
   * the expansion onto the end of the CV's token run instead, which fixed the
   * unigram case and quietly broke the phrase case: "SLA framework" in the CV
   * stopped being a contiguous run once "service level agreement" was spliced
   * between the two words, so an exact match decayed to partial credit. Same
   * rule applied symmetrically to both texts, and they agree by construction —
   * the same reason stem() is applied to both sides rather than one.
   */
  function expandAcronyms(tokens) {
    const out = [];
    tokens.forEach((token) => {
      // CVs write them plural — "ran QBRs", "owns the SLAs".
      const base = ACRONYMS.has(token) ? token
        : (token.endsWith('s') && ACRONYMS.has(token.slice(0, -1)) ? token.slice(0, -1) : null);
      if (base) out.push(...tokenize(ACRONYMS.get(base)));
      else out.push(token);
    });
    return out;
  }

  function buildHaystack(text) {
    const tokens = expandAcronyms(tokenize(text)).map(stem);
    return { set: new Set(tokens), joined: ` ${tokens.join(' ')} ` };
  }

  const PARTIAL_CREDIT = 0.5;

  /**
   * Returns 1 for an exact hit, PARTIAL_CREDIT when every token of a phrase is
   * somewhere in the CV but not as a contiguous run, 0 otherwise.
   *
   * The partial tier matters because containment dedup deliberately keeps only
   * the longest phrase from each requirement. Without partial credit, a CV that
   * says "vendor management" scores nothing against a posting that says "vendor
   * operations manager" — and a 0 on a CV that is plainly in the right field
   * reads as a broken scorer, not as useful feedback. Real keyword screens are
   * token-based far more often than they are phrase-exact.
   */
  function termCredit(haystack, entry) {
    if (!entry.phrase) return haystack.set.has(entry.key) ? 1 : 0;
    if (haystack.joined.includes(` ${entry.key} `)) return 1;

    // Graded rather than binary: "regulated financial services" against a CV
    // that says "financial services" is two thirds of the way there and should
    // score like it. Below half the tokens there is no real overlap, so it
    // earns nothing — otherwise every phrase containing a common word would
    // pay out and the score would drift upward for no reason.
    const parts = entry.key.split(' ');
    const present = parts.filter((p) => haystack.set.has(p)).length;
    const ratio = present / parts.length;
    return ratio >= 0.5 ? PARTIAL_CREDIT * ratio : 0;
  }

  /**
   * Scores one CV against an extracted keyword set.
   *
   * The score is weight-recall: the share of the posting's total keyword
   * weight that the CV actually covers. It is NOT the share of keywords —
   * covering the two terms that carry a third of the weight beats covering
   * fifteen incidental ones, which is how screening actually behaves.
   */
  function scoreResume(resumeText, keywords) {
    const haystack = buildHaystack(resumeText);
    const matched = [];
    const partial = [];
    const missing = [];
    let hit = 0;
    let total = 0;

    keywords.forEach((entry) => {
      total += entry.weight;
      const credit = termCredit(haystack, entry);
      hit += entry.weight * credit;
      if (credit === 1) matched.push(entry);
      else if (credit > 0) partial.push({ ...entry, partial: true });
      else missing.push(entry);
    });

    return {
      score: total === 0 ? 0 : Math.round((hit / total) * 100),
      matched,
      partial,
      // An exact gap is more actionable than a near-miss, so exact gaps rank
      // first regardless of weight — "you never say SQL" beats "you say vendor
      // management where they say vendor operations manager".
      missing: missing.concat(partial),
      totalWeight: total,
    };
  }

  /* --- Seniority --------------------------------------------------------- */

  const LEVELS = [
    { name: 'Intern',    rank: 0, re: /\b(intern|internship|trainee|apprentice)\b/i },
    { name: 'Entry',     rank: 1, re: /\b(entry[\s-]?level|graduate|junior|jr\.?|associate|assistant)\b/i },
    { name: 'Mid',       rank: 2, re: /\b(mid[\s-]?level|specialist|analyst|engineer|consultant|officer|executive)\b/i },
    { name: 'Senior',    rank: 3, re: /\b(senior|sr\.?|lead|principal|staff|manager)\b/i },
    { name: 'Leadership',rank: 4, re: /\b(head of|director|vp|vice president|chief|c[teofi]o\b|partner|president)\b/i },
  ];

  function detectLevel(text) {
    const sample = String(text || '').slice(0, 1200);   // title + opening lines
    let best = null;
    LEVELS.forEach((level) => {
      if (level.re.test(sample) && (!best || level.rank > best.rank)) best = level;
    });
    return best || { name: 'Unspecified', rank: -1 };
  }

  function detectYearsRequired(text) {
    // "5+ years", "5 to 7 years", "minimum of 5 years", "five years"
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const digits = String(text || '').match(/(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*(?:\+)?\s*year/gi) || [];
    const spelled = String(text || '').match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b/gi) || [];
    const values = digits
      .map((m) => parseInt(m, 10))
      .concat(spelled.map((m) => words[m.trim().split(/\s+/)[0].toLowerCase()]))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 40);
    return values.length ? Math.min(...values) : null;
  }

  /**
   * Estimates career length from date ranges in the CV. Reads the earliest
   * four-digit year that is plausibly a work date and measures to the latest.
   * Approximate on purpose — it is used to flag a large gap against the
   * posting's stated requirement, not to state a fact about the candidate.
   */
  // "2017 - present", "2017 to date", "2017 -" — an open-ended range means the
  // role is still running, so the span reaches today.
  const OPEN_ENDED = /\b(19[89]\d|20[0-4]\d)\s*(?:-|–|—|to|until|till)\s*(?:present|current|currently|now|date|today|ongoing|continuing)\b/i;

  function estimateYearsExperience(resumeText) {
    const text = String(resumeText || '');
    const thisYear = new Date().getFullYear();
    const years = (text.match(/\b(19[89]\d|20[0-4]\d)\b/g) || [])
      .map(Number)
      .filter((y) => y >= 1980 && y <= thisYear + 1);
    if (!years.length) return null;

    // The current role is almost always written "2017 - present", and "present"
    // is not a four-digit year — so measuring max-minus-min silently stopped the
    // clock at whatever year was last TYPED. A 2014-to-present career came back
    // as 3 years, and that number is printed next to the score as a judgement on
    // the candidate. It under-counts every currently-employed applicant, which
    // is nearly all of them, and worst for whoever has held one role longest.
    const stillThere = OPEN_ENDED.test(text) || /\b(present|current|currently|to date|till date|ongoing)\b/i.test(text);
    const latest = stillThere ? thisYear : Math.max(...years);

    if (years.length < 2 && !stillThere) return null;
    const span = latest - Math.min(...years);
    return span > 0 && span <= 50 ? span : null;
  }

  function compareLevel(resumeText, jobText) {
    const jobLevel = detectLevel(jobText);
    const resumeLevel = detectLevel(resumeText);
    const yearsRequired = detectYearsRequired(jobText);
    const yearsHave = estimateYearsExperience(resumeText);

    let verdict = 'unknown';
    if (jobLevel.rank >= 0 && resumeLevel.rank >= 0) {
      if (resumeLevel.rank === jobLevel.rank) verdict = 'aligned';
      else if (resumeLevel.rank > jobLevel.rank) verdict = 'above';
      else verdict = 'below';
    }

    return {
      jobLevel: jobLevel.name,
      resumeLevel: resumeLevel.name,
      verdict,
      yearsRequired,
      yearsHave,
      yearsShortfall: yearsRequired != null && yearsHave != null ? Math.max(0, yearsRequired - yearsHave) : null,
    };
  }

  /* --- ATS-safety checks ------------------------------------------------- */

  /**
   * Rezi's contribution to the category: a parse-safety check on the document
   * itself, independent of the job. Everything checked here is something a
   * real ATS parser is known to mishandle or a recruiter is known to look for.
   * Each finding names the fix, because a warning you cannot act on is noise.
   */
  function auditStructure(markdown) {
    const text = String(markdown || '');
    const lines = text.split(/\r?\n/);
    const findings = [];

    const hasName = /^#\s+\S/m.test(text);
    if (!hasName) {
      findings.push({ level: 'fail', label: 'No name heading', detail: 'The document should open with your full name so the parser can attach every other field to a person.' });
    }

    const hasContact = /(@|\+\d|\(\d{3}\)|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/.test(text.slice(0, 400));
    if (!hasContact) {
      findings.push({ level: 'fail', label: 'No contact line', detail: 'An email or phone number must appear in the first few lines — parsers stop looking after the header.' });
    }

    const sections = (text.match(/^##+\s+(.+)$/gm) || []).map((h) => h.replace(/^#+\s+/, '').trim().toLowerCase());
    ['experience', 'education', 'skill'].forEach((needle) => {
      if (!sections.some((s) => s.includes(needle))) {
        findings.push({ level: 'warn', label: `No ${needle} section`, detail: `Most parsers map content to standard headings. Add a clearly named ${needle} section.` });
      }
    });

    if (/\|.*\|.*\|/.test(text)) {
      findings.push({ level: 'fail', label: 'Table detected', detail: 'Tables are the single most common cause of scrambled ATS parsing. Use plain headings and bullets.' });
    }
    if (/!\[[^\]]*\]\(/.test(text)) {
      findings.push({ level: 'fail', label: 'Image detected', detail: 'Images carry no text to a parser and can break the layout on export.' });
    }

    const bullets = lines.filter((l) => /^\s*[-*+•]\s+/.test(l));
    const longBullets = bullets.filter((l) => l.trim().length > 240);
    if (longBullets.length) {
      findings.push({ level: 'warn', label: `${longBullets.length} overlong bullet${longBullets.length > 1 ? 's' : ''}`, detail: 'Bullets over about 35 words stop being scannable. Split them.' });
    }

    const words = (text.match(/\b[\w'+#.-]+\b/g) || []).length;
    if (words < 250) {
      findings.push({ level: 'warn', label: 'Very short', detail: `About ${words} words. Under roughly 250 there is usually not enough evidence for a recruiter to act on.` });
    } else if (words > 1100) {
      findings.push({ level: 'warn', label: 'Very long', detail: `About ${words} words — likely over two pages. Trim the oldest, least relevant roles first.` });
    }

    const quantified = bullets.filter((l) => /\d/.test(l)).length;
    const quantRatio = bullets.length ? quantified / bullets.length : 0;
    if (bullets.length >= 4 && quantRatio < 0.3) {
      findings.push({ level: 'warn', label: 'Few quantified bullets', detail: `Only ${quantified} of ${bullets.length} bullets contain a number. Numbers are the strongest single signal on a resume.` });
    }

    return {
      findings,
      passed: findings.filter((f) => f.level === 'fail').length === 0,
      stats: { words, bullets: bullets.length, quantified, sections: sections.length },
    };
  }

  /* --- Public entry point ------------------------------------------------ */

  /**
   * One call, everything the panel needs.
   *
   * `optimized` is optional — before a rewrite exists the report is still
   * useful (it tells you where you stand and what to add), and after one it
   * carries the before/after delta that proves the rewrite did something.
   */
  function analyze(resumeText, jobText, optimizedText) {
    const keywords = extractKeywords(jobText);
    const before = scoreResume(resumeText, keywords);
    const after = optimizedText ? scoreResume(optimizedText, keywords) : null;

    // Terms the rewrite genuinely introduced — the honest measure of its work.
    const gained = after
      ? after.matched.filter((k) => !before.matched.some((b) => b.key === k.key))
      : [];

    return {
      keywords,
      before,
      after,
      gained,
      delta: after ? after.score - before.score : null,
      level: compareLevel(resumeText, jobText),
      structure: optimizedText ? auditStructure(optimizedText) : null,
      // Missing terms are ranked by weight, so the first three are the three
      // that would move the score most.
      topGaps: (after || before).missing.slice(0, 12),
    };
  }

  return {
    analyze,
    extractKeywords,
    scoreResume,
    compareLevel,
    auditStructure,
    detectLevel,
    detectYearsRequired,
    estimateYearsExperience,
    normalize,
    stem,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MatchEngine;
