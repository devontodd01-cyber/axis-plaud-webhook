// api/plaud-webhook.js
// Receives Plaud transcript from Zapier → parses with Claude → writes to Axis CRM Supabase

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;           // https://untsjmmqtfasejkwjnlf.supabase.co
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;       // optional security token

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional secret validation (set in Zapier as a header or query param)
  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;
    console.log('Plaud webhook received:', JSON.stringify(body, null, 2));

    // Extract transcript from Zapier payload
    // Plaud sends: transcript, summary, title, created_at, duration
    const transcript = body.transcript || body.text || body.content || '';
    const plaudSummary = body.summary || '';
    const recordingTitle = body.title || body.name || '';
    const recordedAt = body.created_at || body.date || new Date().toISOString();
    const duration = body.duration || null;

    if (!transcript && !plaudSummary) {
      return res.status(400).json({ error: 'No transcript or summary in payload' });
    }

    const inputText = transcript || plaudSummary;

    // ── Step 1: Parse with Claude ──────────────────────────────────────────
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
        system: `You are an AI assistant for Axis CRM, a field service CRM for a dental milling machine service company in Calgary, Alberta, Canada. The lead technician is Devon.

Common machines: Roland DWX-51, DWX-51D, DWX-52DCi, DWX-53DC, imes-icore CORiTEC 350i, CORiTEC 450i, CORiTEC 550i.
Common job types: Preventive Maintenance, Spindle Repair, Axis Calibration, Software Support, Emergency Repair, Parts Installation, Training, Warranty.
Common parts: spindle, A-axis gear, B-axis gear, drawbar, collet, milling burs, disc holder, coolant pump, controller board, VPanel, calibration block.
Common customers: dental labs in Alberta.

Extract structured job data from the voice transcript. If the technician says a customer name, machine model, serial number, or parts needed — capture them exactly.

Respond ONLY with valid JSON. No preamble, no markdown, no backticks. Use exactly this structure:
{
  "customer": "customer/lab name, or null if not mentioned",
  "machine": "machine model, or null",
  "serial": "serial number, or null",
  "job_type": "one of: Preventive Maintenance | Spindle Repair | Axis Calibration | Software Support | Emergency Repair | Parts Installation | Training | Warranty | Service Call | Other",
  "status": "one of: Completed | Parts Pending | Follow-up Required | In Progress | Pending",
  "priority": "one of: Urgent | High | Normal | Low",
  "notes": "2-3 sentence professional job note describing work performed",
  "key_points": "bullet summary of technical findings, max 4 points, each starting with •",
  "parts_needed": ["list of parts to order, or empty array"],
  "followup": true or false,
  "followup_note": "what the follow-up is, or null",
  "followup_date": "YYYY-MM-DD if a specific date is mentioned, or null",
  "action_items": [
    { "type": "parts|followup|call|task|quote", "text": "action description", "due": "timeframe or null" }
  ]
}`,
        messages: [{
          role: 'user',
          content: `Parse this field service voice log into structured job data:\n\n${inputText}`
        }]
      })
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      console.error('Claude API error:', err);
      throw new Error(`Claude API failed: ${claudeResponse.status}`);
    }

    const claudeData = await claudeResponse.json();
    const rawText = claudeData.content.map(b => b.text || '').join('');
    const clean = rawText.replace(/```json|```/g, '').trim();
    let parsed;

    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('JSON parse failed:', clean);
      throw new Error('Claude returned invalid JSON');
    }

    console.log('Claude parsed:', JSON.stringify(parsed, null, 2));

    // ── Step 2: Write job to Supabase ──────────────────────────────────────
    const jobPayload = {
      customer: parsed.customer || 'Unknown Customer',
      machine: parsed.machine || null,
      serial_number: parsed.serial || null,
      job_type: parsed.job_type || 'Service Call',
      status: parsed.status || 'Pending',
      priority: parsed.priority || 'Normal',
      notes: buildFullNote(parsed, inputText, recordingTitle, recordedAt, duration),
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

    if (!supabaseRes.ok) {
      const err = await supabaseRes.text();
      console.error('Supabase error:', err);
      throw new Error(`Supabase insert failed: ${supabaseRes.status} — ${err}`);
    }

    const [newJob] = await supabaseRes.json();
    console.log('Job created:', newJob.id);

    // ── Step 3: Write action items as follow-up tasks ──────────────────────
    if (parsed.action_items && parsed.action_items.length > 0) {
      const actionPayloads = parsed.action_items.map(item => ({
        job_id: newJob.id,
        type: item.type,
        text: item.text,
        due: item.due || null,
        completed: false,
        created_at: new Date().toISOString()
      }));

      // Write to action_items table (create if it doesn't exist yet)
      const actionsRes = await fetch(`${SUPABASE_URL}/rest/v1/action_items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(actionPayloads)
      });

      if (!actionsRes.ok) {
        // Non-fatal — log but don't fail the whole request
        console.warn('Action items insert failed (table may not exist yet):', await actionsRes.text());
      }
    }

    // ── Step 4: Write calendar note if follow-up date specified ───────────
    if (parsed.followup && parsed.followup_date) {
      const calNote = {
        date: parsed.followup_date,
        note: `[Auto] Follow-up: ${parsed.followup_note || parsed.customer} — Job #${newJob.id}`,
        job_id: newJob.id,
        created_at: new Date().toISOString()
      };

      await fetch(`${SUPABASE_URL}/rest/v1/calendar_notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(calNote)
      });
    }

    // ── Success response ───────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      job_id: newJob.id,
      customer: parsed.customer,
      machine: parsed.machine,
      status: parsed.status,
      action_items_count: parsed.action_items?.length || 0,
      followup_scheduled: !!(parsed.followup && parsed.followup_date),
      message: `Job created for ${parsed.customer || 'Unknown'} — ${parsed.machine || 'Unknown machine'}`
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({
      error: error.message,
      success: false
    });
  }
}

// Build a clean full note combining AI summary + raw transcript
function buildFullNote(parsed, transcript, title, recordedAt, duration) {
  const date = new Date(recordedAt).toLocaleDateString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const parts = [];

  parts.push(`📍 VOICE LOG — ${date}${duration ? ` (${Math.round(duration / 60)} min)` : ''}`);
  if (title) parts.push(`Recording: ${title}`);
  parts.push('');
  parts.push('SUMMARY:');
  parts.push(parsed.notes || '');
  parts.push('');
  parts.push('KEY POINTS:');
  parts.push(parsed.key_points || '');

  if (parsed.parts_needed && parsed.parts_needed.length > 0) {
    parts.push('');
    parts.push('PARTS NEEDED:');
    parsed.parts_needed.forEach(p => parts.push(`• ${p}`));
  }

  if (parsed.action_items && parsed.action_items.length > 0) {
    parts.push('');
    parts.push('ACTION ITEMS:');
    parsed.action_items.forEach(a =>
      parts.push(`• [${a.type.toUpperCase()}] ${a.text}${a.due ? ' — ' + a.due : ''}`)
    );
  }

  parts.push('');
  parts.push('─────────────────────────');
  parts.push('RAW TRANSCRIPT:');
  parts.push(transcript.slice(0, 3000)); // cap at 3000 chars

  return parts.join('\n');
}
