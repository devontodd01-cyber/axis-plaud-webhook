export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
        system: `You are a CRM data extractor for a dental CAD/CAM milling machine field service company based in Canada. 
Extract structured job data from voice transcripts spoken by a field technician.

Return ONLY valid JSON with exactly these fields:
{
  "customer": "company name mentioned (e.g. VHF, Core3d, Protec CB, Astro Dental) — do not include words like 'customer' or 'client'",
  "equipment": "machine model and serial number if given (e.g. E5 SN:EY342432432CSD, DWX-52D ZDJ0203, 350i Pro)",
  "technician": "Devon",
  "job_id": "VOICE-[4 random digits]",
  "date": "today in YYYY-MM-DD format",
  "status": "one of: Pending | In Progress | Complete | Dispatched",
  "priority": "one of: Normal | High | Urgent | Low",
  "invoice_status": "Not Invoiced",
  "amount": null,
  "notes": "work description, issues found, parts needed, and any other details — written as field service notes",
  "followup": true or false,
  "followup_note": "reason for follow-up if any, otherwise null",
  "followup_date": "YYYY-MM-DD if a follow-up day is mentioned (e.g. 'follow up Thursday'), otherwise null"
}

Rules:
- customer: extract just the company name, strip filler words
- equipment: combine model + serial number into one string if both given
- status: use "Pending" if job not yet done, "In Progress" if on-site, "Complete" if finished
- notes: include ALL work details — inspection findings, parts, billing notes, shipping, everything mentioned
- followup: set true if any follow-up action is mentioned
- Do not include markdown, code fences, or explanation — return raw JSON only`,
        messages: [{ role: 'user', content: 'Transcript: ' + inputText }]
      })
    });

    const claudeText = await claudeRes.text();
    console.log('Claude status:', claudeRes.status);
    console.log('Claude body:', claudeText);

    const claudeData = JSON.parse(claudeText);
    const rawText = claudeData.content[0].text;
    const parsed = JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());

    // Build job payload matching Axis CRM jobs table exactly
    const jobPayload = {
      job_id:         parsed.job_id || ('VOICE-' + Math.floor(1000 + Math.random() * 9000)),
      customer:       parsed.customer || 'Unknown',
      equipment:      parsed.equipment || null,
      technician:     parsed.technician || 'Devon',
      status:         parsed.status || 'Pending',
      priority:       parsed.priority || 'Normal',
      date:           parsed.date || new Date().toISOString().split('T')[0],
      amount:         parsed.amount || null,
      invoice_status: parsed.invoice_status || 'Not Invoiced',
      notes:          '🎙 VOICE LOG\n\n' + (parsed.notes || '') + '\n\n— Raw transcript:\n' + inputText.slice(0, 1000),
      followup:       parsed.followup || false,
      followup_note:  parsed.followup_note || null,
      followup_date:  parsed.followup_date || null,
      source:         'voice'
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
      success:  true,
      job_id:   newJob.job_id || newJob.id,
      customer: parsed.customer,
      machine:  parsed.equipment,
      status:   parsed.status
    });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message, success: false });
  }
}
