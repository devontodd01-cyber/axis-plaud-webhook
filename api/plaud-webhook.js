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
    const transcript = body.transcript || body.text || body.content || '';
    const plaudSummary = body.summary || '';
    const recordingTitle = body.title || body.name || '';
    const recordedAt = body.created_at || new Date().toISOString();
    const duration = body.duration || null;
    const inputText = transcript || plaudSummary;

    if (!inputText) {
      return res.status(400).json({ error: 'No transcript or summary in payload' });
    }

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
        system: `You are an AI assistant for Axis CRM, a field service CRM for a dental milling machine service company in Calgary, Alberta. The technician is Devon.

Common machines: Roland DWX-51, DWX-51D, DWX-52DCi, DWX-53DC, imes-icore CORiTEC 350i, 450i, 550i.
Common job types: Preventive Maintenance, Spindle Repair, Axis Calibration, Software Support, Emergency Repair, Parts Installation, Training, Warranty, Service Call.
Common parts: spindle, A-axis gear, B-axis gear, drawbar, collet, milling burs, disc holder, coolant pump, controller board.

Respond ONLY with valid JSON, no preamble, no markdown:
{
  "customer": "customer name or null",
  "machine": "machine model or null",
  "serial": "serial number or null",
  "job_type": "Service Call",
  "status": "Completed | Parts Pending | Follow-up Required | In Progress | Pending",
  "priority": "Urgent | High | Normal | Low",
  "notes": "2-3 sentence professional job note",
  "key_points": "bullet points starting with •",
  "parts_needed": ["array of parts or empty"],
  "followup": true or false,
  "followup_note": "followup description or null",
  "followup_date": "YYYY-MM-DD or null",
  "action_items": [
    { "type": "parts|followup|call|task|quote", "text": "description", "due": "timeframe or null" }
  ]
}`,
        messages: [{ role: 'user', content: `Parse this field service voice log:\n\n${inputText}` }]
      })
    });

    const claudeData = await claudeResponse.json();
    const rawText = claudeData.content.map(b => b.text || '').join('');
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    const date = new Date(recordedAt).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const fullNote = [
      `📍 VOICE LOG — ${date}${duration ? ` (${Math.round(duration / 60)} min)` : ''}`,
      recordingTitle ? `Recording: ${recordingTitle}` : '',
      '', 'SUMMARY:', parsed.notes || '',
      '', 'KEY POINTS:', parsed.key_points || '',
      parsed.parts_needed?.length ? '\nPARTS NEEDED:\n' + parsed.parts_needed.map(p => `• ${p}`).join('\n') : '',
      parsed.action_items?.length ? '\nACTION ITEMS:\n' + parsed.action_items.map(a => `• [${a.type.toUpperCase()}] ${a.text}${a.due ? ' — ' + a.due : ''}`).join('\n') : '',
      '', '─────────────────────────', 'RAW TRANSCRIPT:', inputText.slice(0, 3000)
    ].filter(Boolean).join('\n');

    const jobPayload = {
      customer: parsed.customer || 'Unknown Customer',
      machine: parsed.machine || null,
      serial_number: parsed.serial || null,
      job_type: parsed.job_type || 'Service Call',
      status: parsed.status || 'Pending',
      priority: parsed.priority || 'Normal',
      notes: fullNote,
      followup: parsed.followup || false,
      followup_note: parsed.followup_note || null,
      followup_date: parsed.followup_date || null,
      created_at: new Date().toISOString(),
      source: 'plaud_voice'
    };

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

    const [newJob] = await supabaseRes.json();

    if (parsed.action_items?.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/action_items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(parsed.action_items.map(item => ({
          job_id: newJob.id,
          type: item.type,
          text: item.text,
          due: item.due || null,
          completed: false,
          created_at: new Date().toISOString()
        })))
      });
    }

    if (parsed.followup && parsed.followup_date) {
      await fetch(`${SUPABASE_URL}/rest/v1/calendar_notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          date: parsed.followup_date,
          note: `[Auto] Follow-up: ${parsed.followup_note || parsed.customer} — Job #${newJob.id}`,
          job_id: newJob.id,
          created_at: new Date().toISOString()
        })
      });
    }

    return res.status(200).json({
      success: true,
      job_id: newJob.id,
      customer: parsed.customer,
      machine: parsed.machine,
      status: parsed.status,
      action_items_count: parsed.action_items?.length || 0,
      followup_scheduled: !!(parsed.followup && parsed.followup_date)
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message, success: false });
  }
}