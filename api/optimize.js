const SYSTEM_PROMPT = `You are a precise, professional resume optimization engine running in a privacy-first sandbox.

Rules you must follow exactly:
1. Always begin the output with the candidate's name as a level-1 heading ("# Full Name"), followed immediately by one line of their contact details (phone, email, location — whichever appear in the source), copied verbatim. Never omit, shorten, or invent this header — it must be the first thing in the document.
2. Reproduce the candidate's full work-history record exactly: every employer name, job title, and date range from the source must appear in the output, verbatim and in the same chronological order, each as its own heading. These are factual records, not achievements to rephrase — never paraphrase, merge, summarize away, or fold them into theme-based groupings that drop the who/where/when.
3. Reproduce every other factual section present in the source in full: every degree, institution, and year under Education; every award, certification, or named credential; any other distinct section (side activities, languages, publications, etc.). Never drop a section just because its content resists an achievement-style rewrite — carry it through as-is rather than deleting it.
4. Within each role, reframe its existing responsibility/achievement bullet points so they speak to the target job description's stated requirements and language. Use the XYZ structure — "Accomplished [X] as measured by [Y], by doing [Z]" — as a guide for individual achievement bullets, not as a rigid template stamped on every line in the document (and never on headings, dates, section titles, or factual records). Vary sentence construction across bullets — a wall of identically-shaped sentences reads as robotic and undermines the goal of sounding professional.
5. Never invent job titles, employers, dates, metrics, skills, or credentials that are not present in the source. If a number is missing, sharpen the framing of what is already there instead of fabricating one.
6. Return clean, production-ready Markdown only — no preamble, no commentary, no wrapping explanation.`;

const ALLOWED_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const MAX_INPUT_LENGTH = 20000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const { resume, job, model } = req.body || {};

  if (typeof resume !== 'string' || typeof job !== 'string' || !resume.trim() || !job.trim()) {
    res.status(400).json({ error: 'Resume and job description are both required.' });
    return;
  }

  if (resume.length > MAX_INPUT_LENGTH || job.length > MAX_INPUT_LENGTH) {
    res.status(413).json({ error: 'That input is too long — trim it down and try again.' });
    return;
  }

  const selectedModel = ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0];
  const userContent = `CANDIDATE PROFILE:\n${resume}\n\nTARGET JOB DESCRIPTION:\n${job}`;

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        temperature: 0.15,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });

    const payload = await groqResponse.json().catch(() => null);

    if (!groqResponse.ok) {
      res.status(groqResponse.status).json({ error: payload?.error?.message || `Optimization engine returned ${groqResponse.status}.` });
      return;
    }

    res.status(200).json({ result: payload.choices[0].message.content });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the optimization engine. Try again in a moment.' });
  }
};
