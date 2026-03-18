// lib/memory.js
const supabase = require('./supabase');

const MAX_HISTORY_MESSAGES = 12;

async function fetchContext(issue) {
  // Fetch conversation history
  const { data: messages, error } = await supabase
    .from('issue_messages')
    .select('role, content, created_at')
    .eq('issue_id', issue.id)
    .not('role', 'eq', 'system') // exclude system logs
    .order('created_at', { ascending: true })
    .limit(MAX_HISTORY_MESSAGES);

  if (error) {
    console.error('[memory] Failed to fetch messages:', error.message);
  }

  const history = (messages || []).map(m => ({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  // Build issue summary string for context injection
  const issueSummary = [
    `Issue ID: ${issue.short_id}`,
    `Title: ${issue.title}`,
    `Department: ${issue.department}`,
    `Status: ${issue.status}`,
    issue.description ? `Description: ${issue.description}` : null,
    issue.steps_tried ? `Steps already tried: ${issue.steps_tried}` : null,
    issue.summary     ? `Running summary: ${issue.summary}`        : null,
  ].filter(Boolean).join('\n');

  return {
    history,        // array of {role, content} for LLM messages array
    issueSummary,   // string injected into system prompt
    messageCount: history.length
  };
}

module.exports = { fetchContext };
