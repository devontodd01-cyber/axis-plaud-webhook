export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
    const secret = req.headers['x-webhook-secret'] || req.query.secret;
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const body = req.body;
    const inputText = body.transcript || body.text || body.summary || '';
    if (!inputText) {
      return res.status(400).json({ error: 'No transcript in payload' });
    }
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: 'You are an AI for a dental milling machine field service CRM. Extract job data from voice transcripts. Respond ONLY with valid JSON with these fields: customer, machine, status (Completed|Parts Pending|Follow-up Required|Pending), priority (Normal|High|Urgent|Low), notes (2-3 sentence summary), followup (true/false), followup_note (string or null), followup_date (YYYY-MM-DD or null).',
        messages: [{ role: 'user', content: 'Parse this transcript: ' + inputText }]
      })
    });
    const claudeText = await claudeRes.text();
    console.log('Claude status:', claudeRes.status);
    console.log('Claude body:', claudeText);
    const claudeData = JSON.parse(claudeText);
    const rawText = claudeData.content[0].text;
    const parsed = JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
    const jobPayload = {
      customer: parsed.customer || 'Unknown',
      machine: parsed.machine || null,
      status: parsed.status || 'Pending',
      priority: parsed.priority || 'Normal',
      notes: '📍 VOICE LOG\n\n' + parsed.notes + '\n\nRAW:\n' + inputText.slice(0, 2000),
      followup: parsed.followup || false,
      followup_note: parsed.followup_note || null,
      followup_date: parsed.followup_date || null,
      created_at: new Date().toISOString()
    };
    console.log('Job payload:', JSON.stringify(jobPayload));
    const sbRes = await fetch(SUPABASE_URL + '/rest/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(jobPayload)
    });
    const sbText = await sbRes.text();
    console.log('Supabase status:', sbRes.status);
    console.log('Supabase body:', sbText);
    if (!sbRes.ok) {
      throw new Error('Supabase failed: ' + sbRes.status + ' ' + sbText);
    }
    const rows = JSON.parse(sbText);
    const newJob = Array.isArray(rows) ? rows[0] : rows;
    return res.status(200).json({
      success: true,
      job_id: newJob.id,
      customer: parsed.customer,
      machine: parsed.machine,
      status: parsed.status
    });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message, success: false });
  }
}
