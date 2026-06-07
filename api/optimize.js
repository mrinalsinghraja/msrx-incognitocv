const SYSTEM_PROMPT = `You are a precise, professional resume optimization engine running in a privacy-first sandbox.

Rules you must follow exactly:
1. Re-frame the candidate's existing achievements so they speak directly to the target job description's stated requirements and language.
2. Convert every bullet point into the XYZ structure: "Accomplished [X] as measured by [Y], by doing [Z]".
3. Never invent job titles, employers, dates, or metrics. If a number is missing, sharpen the framing of what is already there instead of fabricating one.
4. Return clean, production-ready Markdown only — no preamble, no commentary, no wrapping explanation.`;

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
