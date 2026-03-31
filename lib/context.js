// lib/context.js — Derived incident state and escalation briefing
// No database writes for state. Reads existing data only.

const supabase = require('./supabase');
const { chatFast } = require('./cloudflare');
const { getAllSupportRoleIds } = require('./speaker');

const ESCALATION_COLOR = 0xED4245;

// ── Cooldown-based escalation check (no new DB column) ──────────────
// Uses existing 'AGENT escalation' system messages as timestamp source.

/**
 * Check whether escalation is allowed based on cooldown rules.
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
async function canEscalate(issueId) {
  const { data } = await supabase
    .from('issue_messages')
    .select('created_at')
    .eq('issue_id', issueId)
    .eq('role', 'system')
    // Match ONLY real escalations — uses em dash (—) to exclude
    // "AGENT escalation-suppressed" messages (which use a regular hyphen)
    .ilike('content', 'AGENT escalation —%')
    .order('created_at', { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return { allowed: true, reason: 'first_escalation' };

  const lastEsc = new Date(data[0].created_at);
  const now = new Date();
  const minutesSince = (now - lastEsc) / 60000;

  // Hard minimum: 30 minutes
  if (minutesSince < 30) return { allowed: false, reason: 'cooldown_30min' };

  // Time-based reset: 2 hours
  if (minutesSince > 120) return { allowed: true, reason: 'cooldown_2h_reset' };

  // Context-based: check new messages since last escalation
  const { count } = await supabase
    .from('issue_messages')
    .select('*', { count: 'exact', head: true })
    .eq('issue_id', issueId)
    .gt('created_at', data[0].created_at.toISOString());

  if (count >= 5) return { allowed: true, reason: 'new_context_5plus_messages' };

  return { allowed: false, reason: 'insufficient_new_context' };
}

// ── Affected user counting ───────────────────────────────────────────

const SAME_ISSUE_PATTERN = /same (issue|here|problem|error)|me too|i also|happens? to me(?: too)?|facing the same/i;

/**
 * Count distinct non-reporter users who said "same issue" etc.
 * @param {import('discord.js').Message[]} threadMessages
 * @param {string} reporterId
 * @returns {number}
 */
function countAffectedUsers(threadMessages, reporterId) {
  const affectedIds = new Set();
  for (const msg of threadMessages) {
    if (msg.author.id === reporterId || msg.author.bot) continue;
    if (SAME_ISSUE_PATTERN.test(msg.content)) {
      affectedIds.add(msg.author.id);
    }
  }
  return affectedIds.size;
}

// ── Speaker tagging for message history ──────────────────────────────

function tagMessageRole(msg, reporterId, botId, staffRoleIds) {
  if (msg.author.id === botId) return 'bot';
  if (msg.author.id === reporterId) return 'reporter';
  if (staffRoleIds.some(id => msg.member?.roles.cache.has(id))) return 'staff';
  return 'participant';
}

/**
 * Build a speaker-tagged history string for LLM consumption.
 * @param {import('discord.js').Message[]} threadMessages
 * @param {string} reporterId
 * @param {string} botId
 * @returns {string}
 */
function buildTaggedHistory(threadMessages, reporterId, botId) {
  const staffRoleIds = getAllSupportRoleIds();
  return threadMessages
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(msg => {
      const role = tagMessageRole(msg, reporterId, botId, staffRoleIds);
      const content = msg.content.slice(0, 200);
      return `[${role}] ${content}`;
    })
    .join('\n');
}

// ── Incident state builder ──────────────────────────────────────────

/**
 * Build an in-memory incident state object from issue data + thread messages.
 * Never persisted — derived on demand.
 * @param {object} issue — Supabase issue row
 * @param {import('discord.js').Message[]} threadMessages
 * @param {string} botId
 * @returns {Promise<object>}
 */
async function buildIncidentState(issue, threadMessages, botId) {
  const reporterId = issue.user_discord_id;

  // Problem description: issue title + first reporter message
  const sorted = [...threadMessages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const firstReporterMsg = sorted.find(m => m.author.id === reporterId && !m.author.bot);

  const problemDescription = firstReporterMsg
    ? `${issue.title}. ${firstReporterMsg.content.slice(0, 300)}`
    : issue.title;

  // Bot attempts: collect bot messages (truncated)
  const botAttempts = threadMessages
    .filter(m => m.author.bot)
    .map(m => m.content.slice(0, 100));

  // Unanswered questions: extract from existing escalation system messages
  const unansweredQuestions = [];
  const { data: escalationMsgs } = await supabase
    .from('issue_messages')
    .select('content')
    .eq('issue_id', issue.id)
    .eq('role', 'system')
    .ilike('content', 'AGENT escalation —%');

  if (escalationMsgs) {
    for (const esc of escalationMsgs) {
      const match = esc.content.match(/for: "([^"]+)"/);
      if (match) unansweredQuestions.push(match[1].slice(0, 200));
    }
  }

  // Sentiment: rule-based
  const allUserContent = threadMessages
    .filter(m => m.author.id === reporterId)
    .map(m => m.content.toLowerCase())
    .join(' ');

  let sentiment = 'neutral';
  if (/(urgent|asap|immediately|right now|emergency)/i.test(allUserContent)) {
    sentiment = 'urgent';
  }
  if (/(frustrat|unacceptable|ridiculous|horrible|worst|still waiting|weeks)/i.test(allUserContent)) {
    sentiment = 'frustrated';
  }

  // Dates
  const firstContact = sorted.length > 0
    ? new Date(sorted[0].createdTimestamp)
    : new Date(issue.created_at);

  const firstContactShort = firstContact.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return {
    issueId: issue.short_id,
    department: issue.department || 'unclassified',
    status: issue.status,
    reporterId,
    affectedUserCount: countAffectedUsers(threadMessages, reporterId),
    messageCount: threadMessages.length,
    firstContactShort,
    problemDescription,
    unansweredQuestions,
    botAttempts,
    sentiment,
    taggedHistory: buildTaggedHistory(threadMessages, reporterId, botId)
  };
}

// ── Escalation briefing generation (LLM call, only on escalation) ───

const BRIEFING_PROMPT = `You are generating a support escalation briefing. Given the following speaker-tagged conversation history and incident state, produce a JSON object with these fields:

- problemDescription: 1-2 sentences summarizing what the reporter wants
- unansweredQuestions: list of questions the bot could not answer (from ESCALATE triggers)
- botAttempts: list of things the bot already tried (from bot messages)
- sentiment: one of "frustrated", "neutral", "urgent" based on language cues
- firstContactShort: short date like "Feb 20"
- messageCount: number

Rules:
- Focus on the reporter's core issue, not side conversations
- Only include unanswered questions — if the bot answered something, don't list it
- botAttempts should be brief (one line each)
- If participants confirmed the same issue, note it in problemDescription

Incident state:
{INCIDENT_STATE}

Speaker-tagged history:
{TAGGED_HISTORY}

Return ONLY valid JSON, no markdown fences.`;

/**
 * Generate a structured escalation briefing via LLM.
 * Only called when escalation fires — not per-message.
 * @param {object} incidentState — output of buildIncidentState()
 * @returns {Promise<object>} briefing object
 */
async function generateEscalationBrief(incidentState) {
  const prompt = BRIEFING_PROMPT
    .replace('{INCIDENT_STATE}', JSON.stringify(incidentState, null, 2))
    .replace('{TAGGED_HISTORY}', incidentState.taggedHistory);

  try {
    const result = await chatFast(prompt, [
      { role: 'user', content: 'Generate the briefing JSON.' }
    ]);

    if (!result || typeof result !== 'string') {
      console.warn('[context] Briefing LLM returned empty/null');
      return incidentState;
    }

    // Strip markdown fences if present
    const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned);

    return {
      problemDescription: parsed.problemDescription || incidentState.problemDescription,
      unansweredQuestions: Array.isArray(parsed.unansweredQuestions) ? parsed.unansweredQuestions : incidentState.unansweredQuestions,
      botAttempts: Array.isArray(parsed.botAttempts) ? parsed.botAttempts : incidentState.botAttempts,
      sentiment: ['frustrated', 'neutral', 'urgent'].includes(parsed.sentiment) ? parsed.sentiment : incidentState.sentiment,
      firstContactShort: parsed.firstContactShort || incidentState.firstContactShort,
      messageCount: parsed.messageCount || incidentState.messageCount,
      affectedUserCount: incidentState.affectedUserCount
    };
  } catch (err) {
    console.error('[context] Briefing generation failed:', err.message);
    return incidentState;
  }
}

// ── Escalation embed delivery ────────────────────────────────────────

async function findEscalationPin(thread) {
  try {
    const pins = await thread.messages.fetchPins();
    for (const [, msg] of pins) {
      if (msg.embeds.length > 0 && msg.embeds[0].title?.includes('ESCALATION')) {
        return msg;
      }
    }
  } catch (err) {
    console.warn('[context] Could not fetch pinned messages:', err.message);
  }
  return null;
}

/**
 * Send escalation as a Discord embed + pin it.
 * Unpins any previous escalation embed before pinning the new one.
 */
async function sendEscalationEmbed(thread, issue, briefing, roleId) {
  // Unpin previous escalation embed if exists
  const prevPin = await findEscalationPin(thread);
  if (prevPin) {
    try { await thread.messages.unpin(prevPin.id); } catch (err) {
      console.warn('[context] Could not unpin previous escalation:', err.message);
    }
  }

  const dept = issue.department || 'unclassified';
  const deptLabel = dept.charAt(0).toUpperCase() + dept.slice(1);

  const embed = {
    title: `🔴 ESCALATION — ${issue.short_id}`,
    color: ESCALATION_COLOR,
    fields: [
      { name: '👤 Reporter', value: `<@${issue.user_discord_id || 'unknown'}>`, inline: true },
      { name: '🏷️ Department', value: deptLabel, inline: true },
      { name: '👥 Affected users', value: String(briefing.affectedUserCount || 1), inline: true },
      { name: '**Problem**', value: (briefing.problemDescription || issue.title).slice(0, 500), inline: false },
      { name: '**Unanswered**', value: (briefing.unansweredQuestions || []).map(q => `• ${q}`).join('\n') || 'None captured', inline: false },
      { name: '**Bot attempted**', value: (briefing.botAttempts || []).map(a => `• ${a}`).join('\n') || 'None', inline: false },
    ],
    footer: {
      text: `📊 ${briefing.messageCount || '?'} messages | Since ${briefing.firstContactShort || '?'} | ${briefing.sentiment || 'neutral'}\nUse /resolve ${issue.short_id} once handled.`
    }
  };

  const mentionContent = roleId ? `<@&${roleId}>` : null;
  const msg = await thread.send({ content: mentionContent, embeds: [embed] });

  try { await thread.messages.pin(msg.id); } catch (err) {
    console.warn('[context] Could not pin escalation embed:', err.message);
  }

  return msg;
}

/**
 * Unpin the escalation embed (called on /resolve and /close).
 */
async function unpinEscalationEmbed(thread) {
  const pin = await findEscalationPin(thread);
  if (pin) {
    try { await thread.messages.unpin(pin.id); } catch (err) {
      console.warn('[context] Could not unpin escalation on resolve/close:', err.message);
    }
  }
}

// ── Ball-holder detection for smart reminders ────────────────────────

const BALLHOLDER_PROMPT = `You are analyzing a stale support thread (no activity for 48+ hours).
Determine who "holds the ball" — who needs to act next.

Return exactly one of: staff, user, staff_urgent

Rules:
- Always check who sent the LAST message first. If the last message is from staff
  and they acknowledged receipt, indicated they are working on it, or provided a
  status update, return "staff" — do not override this with earlier message patterns.
- "staff" if the last meaningful action was from staff and they need to follow up
- "user" if staff previously asked the user a question and the user has not yet responded
- "staff_urgent" if the user is expressing frustration about being ignored,
  repeatedly @mentioning staff, or complaining about lack of response
- If no staff member has ever replied, default to "staff"

Speaker-tagged history:
{TAGGED_HISTORY}

Return ONLY one of: staff, user, staff_urgent`;

/**
 * LLM-based ball-holder detection for stale issue reminders.
 * Only fires on stale issues — negligible cost.
 * @param {string} taggedHistory
 * @returns {Promise<'staff'|'user'|'staff_urgent'>}
 */
async function detectBallHolder(taggedHistory) {
  try {
    const prompt = BALLHOLDER_PROMPT.replace('{TAGGED_HISTORY}', taggedHistory);
    const result = await chatFast(prompt, [
      { role: 'user', content: 'Who holds the ball?' }
    ]);

    if (!result || typeof result !== 'string') return 'staff';

    const parsed = result.trim().toLowerCase();
    if (['staff', 'user', 'staff_urgent'].includes(parsed)) return parsed;
    return 'staff';
  } catch (err) {
    console.error('[context] Ball-holder detection failed:', err.message);
    return 'staff';
  }
}

// ── Thread Brief system (Fix 2 + Fix 5) ────────────────────────────
// DISABLED: Will be replaced with a more dynamic chat summary system later.
//
// const BRIEF_TITLE = '📋 Thread Brief';
// const BRIEF_COLOR = 0x5865F2; // Discord blurple
//
// async function findThreadBriefPin(thread) { ... }
// function generateBriefEmbed(issues, threadMessages, botId) { ... }
// const _briefMessageCounters = new Map();
// function shouldUpdateBrief(threadId) { ... }
// function resetBriefCounter(threadId) { ... }
// async function updateThreadBrief(thread, issues, botId) { ... }
// async function createNewBriefPin(thread, embed) { ... }

module.exports = {
  canEscalate,
  buildIncidentState,
  generateEscalationBrief,
  sendEscalationEmbed,
  unpinEscalationEmbed,
  detectBallHolder,
  buildTaggedHistory,
  countAffectedUsers,
  // Thread brief exports (Fix 2 + Fix 5) — DISABLED
  // updateThreadBrief,
  // shouldUpdateBrief,
  // resetBriefCounter,
  // findThreadBriefPin
};
