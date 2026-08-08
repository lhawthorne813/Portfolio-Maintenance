// Optional evidence interpretation through the OpenAI Responses API. Rules in
// automation.js remain authoritative; model output never approves spend or
// performs a safety-sensitive action on its own.
const fs = require('fs');
const path = require('path');

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif' })[ext] || 'image/jpeg';
}

function outputText(response) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) if (part.type === 'output_text' && part.text) return part.text;
  }
  return null;
}

async function imageJson(filePath, prompt, name, schema) {
  if (!process.env.OPENAI_API_KEY) return null;
  const image = fs.readFileSync(filePath).toString('base64');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-5.4-mini',
      store: false,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:${mimeFor(filePath)};base64,${image}`, detail: 'auto' }
      ] }],
      text: { format: { type: 'json_schema', name, strict: true, schema } }
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI image analysis failed (${response.status})${detail ? ': ' + detail.slice(0, 160) : ''}`);
  }
  const raw = outputText(await response.json());
  if (!raw) throw new Error('OpenAI image analysis returned no structured result');
  return JSON.parse(raw);
}

const receiptSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    merchant: { type: ['string', 'null'] },
    purchase_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when visible' },
    total: { type: ['number', 'null'] },
    category: { type: 'string', enum: ['materials', 'vendor_invoice', 'equipment', 'other'] },
    items: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { name: { type: 'string' }, quantity: { type: 'number' }, unit_cost: { type: ['number', 'null'] } },
      required: ['name', 'quantity', 'unit_cost'] } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    notes: { type: 'string' }
  },
  required: ['merchant', 'purchase_date', 'total', 'category', 'items', 'confidence', 'notes']
};

const maintenanceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    visible_issue: { type: 'string' },
    likely_category: { type: 'string' },
    safety_flags: { type: 'array', items: { type: 'string' } },
    suggested_checks: { type: 'array', items: { type: 'string' } },
    parts_or_tools: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    limitations: { type: 'string' }
  },
  required: ['visible_issue', 'likely_category', 'safety_flags', 'suggested_checks', 'parts_or_tools', 'confidence', 'limitations']
};

function analyzeReceipt(filePath) {
  return imageJson(filePath,
    'Extract this maintenance receipt. Use only visible evidence. Do not guess an unreadable total or date; return null. Item totals should not be invented.',
    'maintenance_receipt', receiptSchema);
}

function analyzeMaintenancePhoto(filePath) {
  return imageJson(filePath,
    'Describe visible maintenance evidence for a trained property-maintenance worker. Flag immediate hazards. Give only safe, non-destructive checks; do not claim a definitive diagnosis from one photo.',
    'maintenance_photo', maintenanceSchema);
}

module.exports = { analyzeReceipt, analyzeMaintenancePhoto };
