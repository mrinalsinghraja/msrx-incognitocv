/**
 * MSRX IncognitoCV — inference proxy.
 * ---------------------------------------------------------------------------
 * The only server-side code in the product. It exists for exactly one reason:
 * to hold GROQ_API_KEY so the browser never sees it.
 *
 * Contract with the client:
 *   POST /api/optimize  { resume, job, model, mode?, stream? }
 *   mode   'resume' (default) | 'cover'
 *   stream true  -> text/event-stream, `data: {"delta":"..."}` then `data: [DONE]`
 *          false -> application/json, { result, model, mode }
 *
 * PRIVACY: nothing here writes request content anywhere. Errors log a code and
 * a duration, never the resume, the posting or the completion. That is not a
 * nicety — "nothing is ever saved or logged" is the product's headline claim,
 * so a stray console.log(resume) would make the site a lie.
 */

const RESUME_PROMPT = `You are a precise, professional resume optimization engine running in a privacy-first sandbox.

Rules you must follow exactly:
1. Always begin the output with the candidate's name as a level-1 heading ("# Full Name"), followed immediately by one line of their contact details (phone, email, location — whichever appear in the source), copied verbatim. Never omit, shorten, or invent this header — it must be the first thing in the document.
2. Reproduce the candidate's full work-history record exactly: every employer name, job title, and date range from the source must appear in the output, verbatim and in the same chronological order, each as its own heading. These are factual records, not achievements to rephrase — never paraphrase, merge, summarize away, or fold them into theme-based groupings that drop the who/where/when.
3. Reproduce every other factual section present in the source in full: every degree, institution, and year under Education; every award, certification, or named credential; any other distinct section (side activities, languages, publications, etc.). Never drop a section just because its content resists an achievement-style rewrite — carry it through as-is rather than deleting it.
4. Within each role, reframe its existing responsibility/achievement bullet points so they speak to the target job description's stated requirements and language. Use the XYZ structure — "Accomplished [X] as measured by [Y], by doing [Z]" — as a guide for individual achievement bullets, not as a rigid template stamped on every line in the document (and never on headings, dates, section titles, or factual records). Vary sentence construction across bullets — a wall of identically-shaped sentences reads as robotic and undermines the goal of sounding professional.
5. Never invent job titles, employers, dates, metrics, skills, or credentials that are not present in the source. If a number is missing, sharpen the framing of what is already there instead of fabricating one.
6. Return clean, production-ready Markdown only — no preamble, no commentary, no wrapping explanation.
7. Output must stay ATS-parsable: no tables, no images, no multi-column layouts, no text boxes, no emoji, no decorative separators. Use "## SECTION NAME" for sections, "### Employer — Job Title" for roles, a plain date line beneath each role, and "-" bullets. Nothing else.
8. Use the standard section names an applicant tracking system is built to recognise — SUMMARY, EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS — rather than creative alternatives, even when the source used something else.

When reframing bullets under rule 4, weigh these five things — in this order of how much they move a resume from "fine" to "gets the callback":
1. Quantified impact — lead with numbers the source already contains (revenue, percentages, headcount, budget, timeframes, user/customer counts). A bullet with a real metric beats one without, every time. Still governed by rule 5: sharpen the framing around a number that's already there — never invent one that isn't.
2. ATS & keyword match — mirror the target job description's exact terms (tools, methodologies, certifications, role titles) wherever the candidate's real background genuinely supports that language. This is what clears the screening system and still reads as a strong match to the human who looks at it next.
3. Leadership & ownership — where the source shows it, foreground scope: team size, budget owned, stakeholders managed, programs run, business outcomes — instead of leaving it implicit inside a generic task description.
4. Proof of work — if the source mentions live products, portfolios, repos, patents, publications, app-store listings, websites, awards, or certifications, keep them visible and prominent; concrete evidence is what makes the rest of the resume credible.
5. Relevance & recency — give your sharpest, most detailed treatment to the bullets that most align with the target role and are most recent; older or less-aligned roles can run leaner. This changes depth and emphasis ONLY — rules 2 and 3 still require every role, employer, date range, and section to come through, verbatim and in order.`;

const COVER_PROMPT = `You are writing a cover letter for a specific candidate applying to a specific job.

Rules you must follow exactly:
1. Draw every fact from the candidate's own material. Never invent an employer, a metric, a credential, a project, or a motivation the source does not support. If you do not know the hiring manager's name, do not guess one — open with "Dear Hiring Team".
2. Three to four short paragraphs, under 300 words total. A cover letter that runs to a page does not get read.
3. Paragraph one: the specific role, and the single strongest true reason this candidate fits it. No throat-clearing, no "I am writing to apply for".
4. Paragraph two and three: two concrete pieces of evidence from the candidate's actual history, each tied to something the posting explicitly asks for. Prefer evidence carrying a real number from the source.
5. Close with one plain sentence of availability and interest. No "I look forward to hearing from you at your earliest convenience".
6. Plain professional English. No superlatives about oneself ("passionate", "results-driven", "proven track record"), no phrases the reader has seen a thousand times, no em-dash-heavy flourishes.
7. Return clean Markdown only: the letter body, no address block, no subject line, no commentary.`;

const PROMPTS = { resume: RESUME_PROMPT, cover: COVER_PROMPT };

// Groq retired BOTH `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on
// 2026-08-16, which took the fallback down with the preferred model — every
// attempt 404'd, so the resilience below could not save anything. These are the
// vendor's named replacements. Check `GET /openai/v1/models` for what is really
// being served; the deprecation page lags behind it.
const ALLOWED_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
// If the preferred model is rate-limited or erroring, finishing on the smaller
// model beats handing the user a failure. Quality drop is real but recoverable;
// a dead button at the end of a ten-second wait is not.
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

const MAX_INPUT_LENGTH = 20000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 3;

/* --- Rate limiting --------------------------------------------------------
   Per-instance and therefore best-effort: serverless spreads traffic across
   instances, so this is a speed bump against naive hammering from one client,
   not a security control. It is deliberately generous — the honest protection
   against abuse here is the input cap plus Groq's own quota, and a limiter
   that locks out a real candidate mid-application would be worse than the
   abuse it prevents. */
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 12;
const buckets = new Map();

function rateLimited(key) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();   // crude ceiling on instance memory
  return hits.length > RATE_MAX;
}

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim() || 'unknown';
}

/* --- Upstream ------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGroq({ model, system, user, stream, signal }) {
  return fetch(GROQ_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      stream: Boolean(stream),
      temperature: 0.15,
      // gpt-oss models reason before answering and spend those tokens out of
      // this same budget, which llama never did. A resume rewrite is long-form
      // but not hard, so keep the thinking short and leave 4096 for the text.
      reasoning_effort: 'low',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
}

/**
 * Tries the requested model, then retries transient failures with backoff, then
 * drops to the fallback model. Returns the first response that is either OK or
 * a permanent error — there is no point retrying a 400.
 */
async function callWithResilience(opts) {
  let lastError = null;
  let lastResponse = null;
  let lastModel = opts.model;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Last attempt runs on the smaller model, which has separate quota and is
    // roughly four times faster to first token.
    const model = attempt === MAX_ATTEMPTS - 1 && opts.model !== FALLBACK_MODEL
      ? FALLBACK_MODEL
      : opts.model;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const response = await callGroq({ ...opts, model, signal: controller.signal });

      if (response.ok) {
        clearTimeout(timer);
        return { response, model };
      }

      lastResponse = response;
      lastModel = model;

      const retriable = response.status === 429 || response.status >= 500;
      if (!retriable) {
        clearTimeout(timer);
        return { response, model };
      }

      // Honour Retry-After when the upstream sends one; otherwise exponential.
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 4000)
        : 400 * 2 ** attempt;
      lastError = new Error(`upstream_${response.status}`);
      clearTimeout(timer);
      if (attempt < MAX_ATTEMPTS - 1) await sleep(waitMs);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(400 * 2 ** attempt);
    }
  }

  // Retries exhausted. If the upstream ever actually answered, hand that
  // response back so the caller can report what really happened — throwing
  // here turned every exhausted 429 into a "took too long" 504, which sends
  // the user to switch models when the real fix is to wait a minute.
  if (lastResponse) return { response: lastResponse, model: lastModel };
  throw lastError || new Error('upstream_unreachable');
}

/* --- SSE ------------------------------------------------------------------ */

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/**
 * Relays Groq's SSE to the client as our own smaller protocol. We do not pass
 * the upstream frames through verbatim: the client should depend on this
 * contract, not on a vendor's, so swapping inference providers later stays a
 * server-side change.
 */
async function relayStream(upstream, res, meta) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let produced = 0;

  send(res, { meta });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are newline-delimited; the last fragment may be incomplete, so it
    // stays in the buffer until the next chunk completes it.
    const frames = buffer.split('\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) { produced += delta.length; send(res, { delta }); }
      } catch {
        // A malformed frame is not worth failing an otherwise good generation.
      }
    }
  }

  if (produced === 0) send(res, { error: 'The engine returned an empty response. Try again.' });
  res.write('data: [DONE]\n\n');
  res.end();
}

/* --- Handler -------------------------------------------------------------- */

module.exports = async function handler(req, res) {
  const started = Date.now();

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  if (!process.env.GROQ_API_KEY) {
    res.status(503).json({ error: 'The rewriting engine is not configured. Try again later.' });
    return;
  }

  if (rateLimited(clientKey(req))) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'That is a lot of rewrites in one minute. Give it a moment and try again.' });
    return;
  }

  const { resume, job, model, mode, stream } = req.body || {};

  if (typeof resume !== 'string' || typeof job !== 'string' || !resume.trim() || !job.trim()) {
    res.status(400).json({ error: 'Add your resume and the job posting — both are needed.' });
    return;
  }
  if (resume.length > MAX_INPUT_LENGTH || job.length > MAX_INPUT_LENGTH) {
    res.status(413).json({ error: `Keep each input under ${MAX_INPUT_LENGTH.toLocaleString()} characters — trim the oldest roles and try again.` });
    return;
  }

  const selectedMode = PROMPTS[mode] ? mode : 'resume';
  const selectedModel = ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0];
  const userContent = `CANDIDATE PROFILE:\n${resume}\n\nTARGET JOB DESCRIPTION:\n${job}`;

  try {
    const { response, model: usedModel } = await callWithResilience({
      model: selectedModel,
      system: PROMPTS[selectedMode],
      user: userContent,
      stream: Boolean(stream),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      res.status(response.status === 429 ? 429 : 502).json({
        error: detail?.error?.message || 'The rewriting engine turned that request down. Try again in a moment.',
      });
      return;
    }

    if (stream) {
      openStream(res);
      await relayStream(response, res, { model: usedModel, mode: selectedMode });
      return;
    }

    const payload = await response.json();
    const result = payload?.choices?.[0]?.message?.content || '';
    if (!result.trim()) {
      res.status(502).json({ error: 'The engine returned an empty response. Try again.' });
      return;
    }
    res.status(200).json({ result, model: usedModel, mode: selectedMode });
  } catch (err) {
    // Code and duration only. Never the payload — see the privacy note above.
    console.error(`optimize_failed code=${err?.name === 'AbortError' ? 'timeout' : 'upstream'} ms=${Date.now() - started}`);
    if (res.headersSent) {
      send(res, { error: 'The connection dropped part-way through. Try again.' });
      res.end();
      return;
    }
    res.status(504).json({ error: 'The rewriting engine took too long. Try again, or switch to the faster model.' });
  }
};

module.exports.ALLOWED_MODELS = ALLOWED_MODELS;
module.exports.FALLBACK_MODEL = FALLBACK_MODEL;
