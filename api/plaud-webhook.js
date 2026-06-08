export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;
    const inputText = body.transcript || body.text || body.summary || body.content || '';

    if (!inputText) {
      return res.status(400).json({ error: 'No transcript in payload' });
    }

    // Call Claude
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are an AI assistant for Axis CRM for a dental milling machine service company in Calgary. Technician is Devon. Extract job data from voice transcripts. Respond ONLY with valid JSON:
{
  "customer": "name or Unknown",
  "machine": "model or null",
  "status": "Completed | Parts Pending | Follow-up Required | Pending",
  "priority": "Normal",
  "notes": "2-3 sentence summary",
  "followup": false,
  "followup_note": null,
  "followup_date": null
}`,
        messages: [{ role: 'user', content: `Parse: ${inputText}` }]
      })
    });

    const claudeText = await claudeResponse.text();
    console.log('Claude status:', claudeResponse.status);
    console.log('Claude response:', claudeText);

    if (!claudeResponse.ok) {
      throw new Error(`Claude API failed: ${claudeResponse.status} — ${claudeText}`);
    }

    const claudeData = JSON.parse(claudeText);

    if (!claudeData.content || !Array.isArray(claudeData.content)) {
      throw new Error(`Unexpected Claude response structure: ${claudeText}`);
    }

    const rawText = claudeData.content.map(b => b.text || '').join('');
    console.log('Claude parsed text:', rawText);

    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    // Insert job
    const jobPayload = {
      customer: parsed.customer || 'Unknown',
      status: parsed.status || 'Pending',
      priority: parsed.priority || 'Normal',
      notes: `📍 VOICE LOG\n\n${parsed.notes}\n\nRAW:\n${inputText.slice(0, 2000)}`,
      followup: parsed.followup || false,
      followup_note: parsed.followup_note || null,
      followup_date: parsed.followup_date || null,
      created_at: new Date().toISOString()
    };

    console.log('Inserting job:', JSON.stringify(jobPayload));

    const supabaseRes = await fetch(`${SUPABASE_URL}/rest/v1/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(jobPayload)
    });

    const supabaseText = await supabaseRes.text();
    console.log('Supabase status:', supabaseRes.status);
    console.log('Supabase body:', supabaseText);

    if (!supabaseRes.ok) {
      throw new Error(`Supabase failed: ${supabaseRes.status} — ${supabaseText}`);
    }

    const rows = JSON.parse(supabaseText);
    const newJob = Array.isArray(rows) ? rows[0] : rows;

    return res.status(200).json({
      success: true,
      job_id: newJob?.id || 'unknown',
      customer: parsed.customer,
      status: parsed.status
    });

  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(500).json({ error: error.message, success: false });
  }
}