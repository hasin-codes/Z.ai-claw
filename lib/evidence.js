// lib/evidence.js
// Extracts, stores, and validates structured evidence from user messages.
// Evidence is stored as JSONB in issues.evidence and used to build staff briefs.

const { chatFast } = require('./cloudflare');
const supabase = require('./supabase');

// ── Scenario definitions ──────────────────────────────────────────────────────
// Maps scenario name → required evidence fields for that scenario.
// The bot keeps asking until all required fields are populated.

const EVIDENCE_REQUIREMENTS = {
  'billing_1113': ['user_id', 'base_url', 'plan_screenshot', 'charge_timestamp'],
  'subscription_not_showing': ['user_id', 'account_email', 'stripe_receipt', 'plan_screenshot'],
  'card_declined': ['decline_screenshot', 'charge_timestamp'],
  'duplicate_subscription': ['plan_to_keep', 'subscription_screenshot', 'stripe_receipts'],
  'refund_request': ['stripe_receipt', 'user_id', 'refund_reason'],
  'unknown_charge': ['charge_status', 'charge_amount', 'charge_date', 'user_id'],
  'incorrect_invoice': ['invoice_id', 'incorrect_fields', 'correct_values'],
  'cannot_cancel': ['subscription_screenshot', 'plan_type'],
  'billing_portal_broken': ['screen_recording', 'browser_version', 'charge_timestamp'],
  'login_loop': ['screen_recording', 'browser_version', 'charge_timestamp'],
  'token_401': ['error_text', 'request_example'],
  'web_search_mcp_timeout': ['client_name', 'error_text'],
  'charged_for_mcp': ['plan_screenshot', 'charge_screenshot', 'tool_name', 'charge_timestamp'],
  'api_500_timeout': ['charge_timestamp', 'endpoint', 'request_id'],
  'intermittent_errors': ['timestamps', 'error_codes', 'endpoint', 'request_rate'],
  'api_slow': ['plan_type', 'timestamps', 'endpoint', 'latency'],
  'rate_limit_429': ['timestamps', 'request_rate'],
  'concurrency_4028': ['timestamps', 'request_ids'],
  'unexpected_token_json': ['base_url'],
  'endpoint_confusion': ['plan_type', 'base_url'],
  'model_not_found': ['plan_type', 'model_name'],
  'mcp_tool_error': ['client_name', 'client_version', 'mcp_screenshot', 'error_text'],
  'vision_slow': ['charge_timestamp', 'latency'],
  'export_pdf': ['plan_type', 'export_location', 'error_text', 'charge_timestamp'],
  'tech_escalation': ['user_id', 'charge_timestamp', 'request_id', 'endpoint', 'payload_snippet'],
  'billing_escalation': ['account_email', 'plan_screenshot', 'stripe_screenshot', 'invoice_id', 'charge_timestamp'],
};

// Human-readable prompts for each field, used when asking the user for missing data
const FIELD_PROMPTS = {
  user_id: 'your User ID (found in your account settings)',
  account_email: 'the email address linked to your account',
  base_url: 'your current API Base URL (please mask your actual key)',
  plan_screenshot: 'a screenshot of your active plan page',
  charge_timestamp: 'the exact timestamp of the issue/charge (include your timezone)',
  stripe_receipt: 'a Stripe receipt or charge screenshot (showing amount, date, and currency)',
  stripe_screenshot: 'a Stripe charge screenshot (showing amount, date, currency, and status)',
  stripe_receipts: 'the relevant Stripe charge receipts (showing amount and date for each)',
  decline_screenshot: 'a screenshot of the decline error message',
  plan_to_keep: 'which plan you would like to keep active',
  subscription_screenshot: 'a screenshot of your active subscriptions page',
  refund_reason: 'a short explanation of what happened (e.g., "I accidentally topped up $33 instead of $3")',
  charge_status: 'the status of the charge (Pending or Succeeded)',
  charge_amount: 'the exact amount, date, and currency of the charge',
  charge_date: 'the date and currency of the charge',
  invoice_id: 'the invoice ID',
  incorrect_fields: 'which fields are incorrect or missing (e.g., company name, VAT, tax ID)',
  correct_values: 'the correct information that should appear on the invoice',
  plan_type: 'your current plan type (e.g., Pro, Max, Coding, Pay-as-you-go)',
  screen_recording: 'a short screen recording showing the issue',
  browser_version: 'your browser name and version',
  error_text: 'the exact error message you are seeing',
  request_example: 'a redacted example request (mask your API key)',
  client_name: 'the name of the client you are using (e.g., VS Code, Cursor, Claude Code)',
  client_version: 'the version of your client',
  charge_screenshot: 'a screenshot of the unexpected charge showing the amount and date',
  tool_name: 'the specific tool or plugin you were using when the charge occurred',
  endpoint: 'the exact API endpoint you are hitting',
  request_id: 'your request ID (if available in your logs or response headers)',
  payload_snippet: 'a redacted code snippet or request payload that reproduces the issue',
  request_rate: 'your approximate request rate (e.g., how many requests per minute)',
  timestamps: '3 to 5 example timestamps when the errors occurred (include timezone)',
  error_codes: 'the specific error codes or messages you received',
  latency: 'the approximate latency you are experiencing (e.g., 10-30 seconds per request)',
  request_ids: 'the request IDs from those failed requests (if available)',
  model_name: 'the exact model name you are trying to use',
  mcp_screenshot: 'a screenshot of your MCP or tool settings',
  export_location: 'exactly where in the product you clicked the export button',
};

// ── Fields that are satisfied by an image/attachment ─────────────────────────
// If the user sends an attachment in the same message, these fields are treated
// as provided (the image IS the evidence). Discord attachment URLs are captured
// as the value so staff can view them directly.
const IMAGE_SATISFIED_FIELDS = new Set([
  'plan_screenshot',
  'stripe_receipt',
  'stripe_screenshot',
  'stripe_receipts',
  'decline_screenshot',
  'subscription_screenshot',
  'screen_recording',
  'charge_screenshot',
  'mcp_screenshot',
]);

// ── Attachment detection ──────────────────────────────────────────────────────

/**
 * Returns true if the Discord message contains any image or file attachment.
 * discordMessage is the raw Discord.js Message object (or null/undefined if
 * the caller passes only the string body). Falls back gracefully to false.
 */
function messageHasAttachment(discordMessage) {
  if (!discordMessage) return false;
  return (
    (discordMessage.attachments && discordMessage.attachments.size > 0) ||
    (discordMessage.embeds && discordMessage.embeds.some(e => e.image || e.thumbnail))
  );
}

/**
 * Extract attachment URLs from a Discord message (images + files).
 * Returns an array of URL strings.
 */
function getAttachmentUrls(discordMessage) {
  if (!discordMessage) return [];
  const urls = [];
  if (discordMessage.attachments) {
    for (const att of discordMessage.attachments.values()) {
      if (att.url) urls.push(att.url);
    }
  }
  return urls;
}

// ── Scenario detection ────────────────────────────────────────────────────────

/**
 * Detect which known scenario best fits this issue based on its title and description.
 * Returns one of the keys from EVIDENCE_REQUIREMENTS, or null if no match.
 */
function detectScenario(issue) {
  const text = `${issue.title || ''} ${issue.description || ''}`.toLowerCase();

  if (text.includes('1113') || text.includes('insufficient balance')) return 'billing_1113';
  if ((text.includes('subscription') || text.includes('plan')) && (text.includes('not showing') || text.includes('not active') || text.includes('missing'))) return 'subscription_not_showing';
  if (text.includes('card declined') || text.includes('payment failed') || text.includes('stripe') && text.includes('decline')) return 'card_declined';
  if (text.includes('duplicate subscription') || text.includes('charged twice') || text.includes('two subscriptions')) return 'duplicate_subscription';
  if (text.includes('refund') || text.includes('accidental top') || text.includes('wrong amount')) return 'refund_request';
  if (text.includes('unknown charge') || text.includes('extra charge') || text.includes('authorization hold') || text.includes('pending charge')) return 'unknown_charge';
  if (text.includes('invoice') && (text.includes('incorrect') || text.includes('missing') || text.includes('vat'))) return 'incorrect_invoice';
  if (text.includes('cannot cancel') || text.includes("can't cancel") || text.includes('cancel button') || text.includes('auto-renewal') || text.includes('auto renewal')) return 'cannot_cancel';
  if (text.includes('billing portal') || text.includes('billing page') || text.includes('billing panel')) return 'billing_portal_broken';
  if (text.includes('login loop') || text.includes('stuck on login') || text.includes("can't login") || text.includes('login after')) return 'login_loop';
  if (text.includes('401') || text.includes('unauthorized') || text.includes('token expired')) return 'token_401';
  if (text.includes('web search') || text.includes('search mcp') || text.includes('headers timeout')) return 'web_search_mcp_timeout';
  if ((text.includes('charged') || text.includes('cash deducted')) && (text.includes('web search') || text.includes('mcp') || text.includes('plugin') || text.includes('tool'))) return 'charged_for_mcp';
  if (text.includes('500') || text.includes('spinning') || text.includes('timeout') && text.includes('api')) return 'api_500_timeout';
  if (text.includes('intermittent') || text.includes('flaky') || (text.includes('500') && text.includes('503'))) return 'intermittent_errors';
  if (text.includes('slow') || text.includes('low tps') || text.includes('latency')) return 'api_slow';
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) return 'rate_limit_429';
  if (text.includes('4028') || text.includes('high concurrency') || text.includes('concurrency')) return 'concurrency_4028';
  if (text.includes('unexpected token') || text.includes('invalid json') || text.includes('html instead')) return 'unexpected_token_json';
  if (text.includes('endpoint') || text.includes('base url') || text.includes('which url') || text.includes('which endpoint')) return 'endpoint_confusion';
  if (text.includes('model not found') || text.includes('no access') || text.includes('permission denied') && text.includes('model')) return 'model_not_found';
  if ((text.includes('mcp') || text.includes('tool') || text.includes('tool-calling')) && (text.includes('not available') || text.includes('failed') || text.includes('error'))) return 'mcp_tool_error';
  if ((text.includes('vision') || text.includes('image')) && (text.includes('slow') || text.includes('timeout'))) return 'vision_slow';
  if (text.includes('export') && text.includes('pdf')) return 'export_pdf';
  if (text.includes('bug') || text.includes('engineering') || text.includes('request id') || text.includes('payload')) return 'tech_escalation';
  if (text.includes('billing bug') || text.includes('entitlement') || text.includes('charged incorrectly') || (text.includes('plan') && text.includes('missing'))) return 'billing_escalation';

  return null;
}

// ── Evidence extraction ───────────────────────────────────────────────────────

/**
 * Use chatFast to extract structured evidence fields from a user message.
 *
 * FIX (natural language parsing): The prompt now explicitly instructs the model
 * to interpret approximate, colloquial, or paraphrased answers — e.g.
 * "maybe 1 or 2 per minute", "around 5", "a couple times" — rather than
 * requiring the user to use the exact phrasing from the question.
 *
 * FIX (attachment detection): If the caller supplies the raw Discord Message
 * object as the third argument, any image/file attachments are detected here
 * and automatically satisfy image-type fields (e.g. plan_screenshot) so the
 * bot never asks for a screenshot that the user already sent.
 *
 * Returns an object with any fields that could be extracted (never throws).
 */
async function extractEvidence(userMessage, scenario, discordMessage = null) {
  if (!scenario) return {};

  const requiredFields = EVIDENCE_REQUIREMENTS[scenario] || [];
  if (requiredFields.length === 0) return {};

  const extracted = {};

  // ── Step 1: Satisfy image fields from attachments ─────────────────────────
  if (messageHasAttachment(discordMessage)) {
    const urls = getAttachmentUrls(discordMessage);
    const urlValue = urls.length > 0 ? urls[0] : '[image attached]';

    for (const field of requiredFields) {
      if (IMAGE_SATISFIED_FIELDS.has(field)) {
        extracted[field] = urlValue;
        console.log(`[evidence] Field "${field}" satisfied by attachment: ${urlValue}`);
      }
    }
  }

  // ── Step 2: Extract remaining text-based fields via LLM ──────────────────
  const remainingFields = requiredFields.filter(f => !extracted[f]);
  if (remainingFields.length === 0) return extracted;

  const fieldList = remainingFields
    .map(f => `"${f}": "${FIELD_PROMPTS[f] || f}"`)
    .join(',\n  ');

  // FIX: explicitly tell the model to accept natural-language approximations.
  // Previously the model would return null for "maybe 1 or 2" because it wasn't
  // a clean number. Now it's instructed to normalise colloquial input.
  const prompt = `You are a data extraction tool for a support system. Extract evidence fields from the user message below.

Output ONLY a valid JSON object — no prose, no explanation, no markdown fences.
If a field is not mentioned at all, set its value to null.
Do not guess. Do not invent values not present in the message.

IMPORTANT — natural language handling:
- Accept approximate or informal answers. For example, if the field is "request_rate" and the user says "maybe 1 or 2 per minute", "around 2 rpm", "a couple requests per minute", or "1-2 rps", treat that as a valid value and record it as-is (e.g. "~1-2 per minute").
- Accept partial timestamps like "around 3pm UTC" or "yesterday at noon".
- Accept vague-but-informative answers like "a few seconds" for latency or "a handful of IDs" for request_ids — record them as the user said them.
- Only return null if the field is genuinely absent from the message.

Required JSON shape (fill in values found in the message):
{
  ${fieldList}
}`;

  try {
    const result = await chatFast(prompt, [
      { role: 'user', content: userMessage }
    ]);

    if (!result || typeof result !== 'string') return extracted;

    let cleaned = result.trim()
      .replace(/^```json?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    if (!cleaned.startsWith('{')) {
      console.warn('[evidence] extractEvidence: model returned non-JSON, discarding:', cleaned.slice(0, 80));
      return extracted;
    }

    const parsed = JSON.parse(cleaned);

    for (const [k, v] of Object.entries(parsed)) {
      if (v !== null && v !== undefined && v !== '') {
        extracted[k] = v;
      }
    }
    return extracted;
  } catch (err) {
    console.error('[evidence] extractEvidence failed:', err.message);
    return extracted;
  }
}

// ── DB merge ──────────────────────────────────────────────────────────────────

/**
 * Merge newly extracted evidence into the existing JSONB column.
 * Preserves existing values — only overwrites if a new value exists for a key.
 */
async function mergeEvidence(issueId, newFields) {
  if (!newFields || Object.keys(newFields).length === 0) return;

  const { data, error: fetchErr } = await supabase
    .from('issues')
    .select('evidence')
    .eq('id', issueId)
    .single();

  if (fetchErr) {
    console.error('[evidence] mergeEvidence fetch error:', fetchErr.message);
    return;
  }

  const existing = data?.evidence || {};
  const merged = { ...existing, ...newFields };

  const { error: updateErr } = await supabase
    .from('issues')
    .update({ evidence: merged })
    .eq('id', issueId);

  if (updateErr) {
    console.error('[evidence] mergeEvidence update error:', updateErr.message);
  } else {
    console.log(`[evidence] Merged ${Object.keys(newFields).length} fields for issue ${issueId}`);
  }
}

// ── Completeness check ────────────────────────────────────────────────────────

/**
 * Check if all required evidence fields for a scenario are populated.
 * Returns { complete: boolean, missing: string[] }
 */
function isEvidenceComplete(scenario, evidence) {
  if (!scenario) return { complete: false, missing: [] };

  const required = EVIDENCE_REQUIREMENTS[scenario] || [];
  const missing = required.filter(field => !evidence[field]);

  return {
    complete: missing.length === 0,
    missing
  };
}

// ── Asking for missing data ───────────────────────────────────────────────────

/**
 * Build a conversational question asking for the first 1-2 missing fields.
 * Keeps the bot from dumping a wall of requirements at once.
 */
function buildMissingFieldsQuestion(missingFields) {
  const toAsk = missingFields.slice(0, 2); // ask max 2 at a time

  if (toAsk.length === 0) return null;

  const prompts = toAsk.map(f => FIELD_PROMPTS[f] || f);

  if (prompts.length === 1) {
    return `To help with this, could you share ${prompts[0]}?`;
  }

  return `To help with this, could you share the following?\n` +
    prompts.map((p, i) => `${i + 1}. ${p.charAt(0).toUpperCase() + p.slice(1)}`).join('\n');
}

// ── Staff brief ───────────────────────────────────────────────────────────────

/**
 * Build a clean staff summary embed text from collected evidence.
 * Used by agent.js to send the final brief before escalating.
 */
function buildEvidenceBrief(issue, scenario, evidence) {
  const lines = [
    `📋 **Evidence collected for ${issue.short_id}**`,
    `**Scenario:** ${scenario || 'Unknown'}`,
    '',
    '**Collected data:**',
  ];

  const required = EVIDENCE_REQUIREMENTS[scenario] || [];
  for (const field of required) {
    const value = evidence[field];
    const label = FIELD_PROMPTS[field] || field;
    if (value) {
      lines.push(`• **${label}:** ${value}`);
    } else {
      lines.push(`• **${label}:** *(not provided)*`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  detectScenario,
  extractEvidence,
  mergeEvidence,
  isEvidenceComplete,
  buildMissingFieldsQuestion,
  buildEvidenceBrief,
  messageHasAttachment,
  getAttachmentUrls,
  IMAGE_SATISFIED_FIELDS,
  EVIDENCE_REQUIREMENTS,
};