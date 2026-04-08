const supabase = require('./supabase');

const MAX_RECENT_MESSAGES = 10;
const ANCHOR_COUNT = 2;
const SUMMARY_INTERVAL = 10; // Generate summary every N messages

/**
 * Fetch context for a specific issue with anchored first messages + sliding window.
 * Never loses the original report context regardless of message count.
 */
async function fetchContext(issue) {
  // 1. Anchor messages: first 2 messages (original report + first bot ack)
  const { data: anchorMessages, error: anchorErr } = await supabase
    .from('issue_messages')
    .select('role, content, created_at')
    .eq('issue_id', issue.id)
    .order('created_at', { ascending: true })
    .limit(ANCHOR_COUNT);

  if (anchorErr) {
    console.error('[memory] Failed to fetch anchor messages:', anchorErr.message);
  }

  // 2. Recent messages: sliding window of last N (includes user + assistant + system)
  const { data: recentMessages, error: recentErr } = await supabase
    .from('issue_messages')
    .select('role, content, created_at')
    .eq('issue_id', issue.id)
    .order('created_at', { ascending: false })
    .limit(MAX_RECENT_MESSAGES);

  if (recentErr) {
    console.error('[memory] Failed to fetch recent messages:', recentErr.message);
  }

  // 3. Important system messages (escalations, status changes) — always include
  const { data: systemMessages, error: sysErr } = await supabase
    .from('issue_messages')
    .select('role, content, created_at')
    .eq('issue_id', issue.id)
    .eq('role', 'system')
    .order('created_at', { ascending: false })
    .limit(5);

  if (sysErr) {
    console.error('[memory] Failed to fetch system messages:', sysErr.message);
  }

  // Deduplicate by created_at and merge: anchors + gap marker + system context + recent
  const seenTimestamps = new Set();
  const allMessages = [];

  // Add anchors first
  for (const m of (anchorMessages || [])) {
    const key = m.created_at;
    if (!seenTimestamps.has(key)) {
      seenTimestamps.add(key);
      allMessages.push(m);
    }
  }

  // Get total message count to decide if we need a gap marker
  const { count: totalCount } = await supabase
    .from('issue_messages')
    .select('*', { count: 'exact', head: true })
    .eq('issue_id', issue.id);

  const hasGap = (totalCount || 0) > (ANCHOR_COUNT + MAX_RECENT_MESSAGES);

  if (hasGap) {
    allMessages.push({
      role: 'system',
      content: `--- ${(totalCount || 0) - ANCHOR_COUNT - MAX_RECENT_MESSAGES} earlier messages omitted ---`,
      created_at: null // synthetic, placed between anchors and recent
    });
  }

  // Add important system messages that aren't in the anchor or recent window
  for (const m of (systemMessages || [])) {
    const key = m.created_at;
    if (!seenTimestamps.has(key)) {
      seenTimestamps.add(key);
      allMessages.push(m);
    }
  }

  // Add recent messages (reverse to chronological order)
  const recentReversed = (recentMessages || []).reverse();
  for (const m of recentReversed) {
    const key = m.created_at;
    if (!seenTimestamps.has(key)) {
      seenTimestamps.add(key);
      allMessages.push(m);
    }
  }

  // Map to LLM format — keep system messages as 'system' role for context
  const history = allMessages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: m.content
  }));

  // Build issue summary string for context injection
  // Include phase and evidence so the LLM knows where the conversation stands
  const evidenceSummary = issue.evidence && Object.keys(issue.evidence).length > 0
    ? `Evidence collected so far: ${Object.entries(issue.evidence).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : null;

  const issueSummary = [
    `Issue ID: ${issue.short_id}`,
    `Title: ${issue.title}`,
    `Department: ${issue.department}`,
    `Status: ${issue.status}`,
    issue.phase ? `Current phase: ${issue.phase}` : null,
    issue.description ? `Description: ${issue.description}` : null,
    issue.steps_tried ? `Steps already tried: ${issue.steps_tried}` : null,
    issue.summary ? `Running summary: ${issue.summary}` : null,
    evidenceSummary,
  ].filter(Boolean).join('\n');

  return {
    history,        // array of {role, content} for LLM messages array
    issueSummary,   // string injected into system prompt
    messageCount: history.length
  };
}

/**
 * Check if the issue needs a running summary update.
 * Called after saving a message — if messageCount crosses a SUMMARY_INTERVAL
 * boundary, generates and stores a 2-sentence summary.
 */
async function maybeUpdateSummary(issue) {
  const { count } = await supabase
    .from('issue_messages')
    .select('*', { count: 'exact', head: true })
    .eq('issue_id', issue.id);

  // Only trigger on multiples of SUMMARY_INTERVAL (10, 20, 30, ...)
  if (!count || count % SUMMARY_INTERVAL !== 0) return;

  // Fetch last N messages for summary generation
  const { data: messages } = await supabase
    .from('issue_messages')
    .select('role, content')
    .eq('issue_id', issue.id)
    .not('role', 'eq', 'system')
    .order('created_at', { ascending: false })
    .limit(SUMMARY_INTERVAL);

  if (!messages || messages.length < 3) return;

  const conversationText = messages.reverse()
    .map(m => `${m.role}: ${m.content.slice(0, 150)}`)
    .join('\n');

  // Use cloudflare chatFast to generate summary
  try {
    const { chatFast } = require('./cloudflare');
    const summaryPrompt = `Summarize this support conversation in exactly 2 sentences. Focus on: what the user wants, what has been tried, and current status. Be factual and concise.`;
    const summary = await chatFast(summaryPrompt, [
      { role: 'user', content: conversationText }
    ]);

    if (summary && typeof summary === 'string' && summary.trim().length > 10) {
      await supabase
        .from('issues')
        .update({ summary: summary.trim().slice(0, 500) })
        .eq('id', issue.id);

      console.log(`[memory] Updated running summary for ${issue.short_id}`);
    }
  } catch (err) {
    console.error('[memory] Summary generation failed:', err.message);
  }
}

module.exports = { fetchContext, maybeUpdateSummary };
