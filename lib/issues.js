const supabase = require('./supabase');
const { detectDepartment } = require('./departments');

async function upsertUser(discordUser) {
  const { error } = await supabase
    .from('users')
    .upsert({
      discord_id:   discordUser.id,
      username:     discordUser.username,
      last_seen_at: new Date().toISOString()
    }, {
      onConflict:       'discord_id',
      ignoreDuplicates: false
    });

  if (error) console.error('upsertUser error:', error.message);
}

async function createIssue({ user, guild, channel, title, description, stepsTried }) {
  await upsertUser(user);

  const department = await detectDepartment(`${title} ${description}`);

  const { data: idData, error: idError } = await supabase
    .rpc('generate_short_id');

  if (idError) {
    console.error('generate_short_id error:', idError.message);
    throw new Error('Could not generate issue ID');
  }

  const { data, error } = await supabase
    .from('issues')
    .insert({
      short_id:        idData,
      user_discord_id: user.id,
      guild_id:        guild.id,
      channel_id:      channel.id,
      department,
      title,
      description,
      steps_tried:     stepsTried || null,
      status:          'open'
    })
    .select()
    .single();

  if (error) {
    console.error('createIssue error:', error.message);
    throw new Error('Could not save issue to database');
  }

  await logStatus({
    issueId:   data.id,
    oldStatus: null,
    newStatus: 'open',
    changedBy: user.id,
    note:      'Issue created by user'
  });

  await supabase.rpc('increment_open_issues', { p_discord_id: user.id });

  return data;
}

async function attachThread(issueId, threadId) {
  const { error } = await supabase
    .from('issues')
    .update({ thread_id: threadId, updated_at: new Date().toISOString() })
    .eq('id', issueId);

  if (error) console.error('attachThread error:', error.message);
}

async function saveMessage({ issueId, role, content, discordMsgId }) {
  const { error } = await supabase
    .from('issue_messages')
    .insert({
      issue_id:       issueId,
      role,
      content,
      discord_msg_id: discordMsgId || null
    });

  if (error) console.error('saveMessage error:', error.message);
}

async function getIssueByShortId(shortId) {
  let normalized = shortId.trim().toUpperCase();

  // Accept both "ISS-1007" and just "1007" — prefix it if missing
  if (!normalized.startsWith("ISS-")) {
    normalized = `ISS-${normalized}`;
  }

  console.log(`[getIssueByShortId] Looking up: "${normalized}"`);

  const { data, error } = await supabase
    .from('issues')
    .select('*')
    .eq('short_id', normalized)
    .maybeSingle();

  if (error) {
    console.error(`[getIssueByShortId] DB error for "${normalized}":`, error.message);
    return null;
  }

  if (!data) {
    console.warn(`[getIssueByShortId] No issue found for "${normalized}"`);
    return null;
  }

  console.log(`[getIssueByShortId] Found: ${data.short_id}`);
  return data;
}

async function getUserOpenIssues(discordId) {
  const { data, error } = await supabase
    .from('issues')
    .select('short_id, title, status, department, created_at')
    .eq('user_discord_id', discordId)
    .not('status', 'in', '(resolved,closed)')
    .order('created_at', { ascending: false });

  if (error) return [];
  return data || [];
}

async function updateStatus({ issueId, newStatus, changedBy, note }) {
  const { data: current } = await supabase
    .from('issues')
    .select('status')
    .eq('id', issueId)
    .single();

  const oldStatus = current?.status || null;

  const updatePayload = {
    status:     newStatus,
    updated_at: new Date().toISOString()
  };

  if (newStatus === 'resolved' || newStatus === 'closed') {
    updatePayload.resolved_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('issues')
    .update(updatePayload)
    .eq('id', issueId);

  if (error) {
    console.error('updateStatus error:', error.message);
    return false;
  }

  await logStatus({ issueId, oldStatus, newStatus, changedBy, note });

  if (newStatus === 'resolved' || newStatus === 'closed') {
    const { data: issue } = await supabase
      .from('issues')
      .select('user_discord_id')
      .eq('id', issueId)
      .single();

    if (issue) {
      await supabase.rpc('decrement_open_issues', { p_discord_id: issue.user_discord_id });
    }
  }

  return true;
}

async function logStatus({ issueId, oldStatus, newStatus, changedBy, note }) {
  const { error } = await supabase
    .from('status_log')
    .insert({
      issue_id:   issueId,
      old_status: oldStatus,
      new_status: newStatus,
      changed_by: changedBy,
      note:       note || null
    });

  if (error) console.error('logStatus error:', error.message);
}

async function isAtIssueLimit(discordId) {
  // DEV MODE — rate limit disabled
  // To re-enable for production, comment the next line out
  if (process.env.NODE_ENV !== "production") return false;

  const { data } = await supabase
    .from("users")
    .select("open_issue_count")
    .eq("discord_id", discordId)
    .single();

  return (data?.open_issue_count || 0) >= 3;
}

async function findSimilarOpenIssue(discordId, title) {
  const { data, error } = await supabase
    .from('issues')
    .select('short_id, title, status, thread_id')
    .eq('user_discord_id', discordId)
    .not('status', 'in', '(resolved,closed)')
    .order('created_at', { ascending: false });

  if (error || !data || data.length === 0) return null;

  const stopWords = new Set([
    'a','an','the','is','it','in','on','at','to','for',
    'of','and','or','but','not','my','i','cant','wont',
    'dont','can','with','was','has','have','from','this'
  ]);

  const newWords = title.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));

  // If title has no meaningful words, skip duplicate check
  if (newWords.length === 0) return null;

  for (const issue of data) {
    const existingWords = issue.title.toLowerCase().split(/\s+/);
    const matches = newWords.filter(w => existingWords.some(ew => ew.includes(w)));
    if (matches.length >= 2) return issue;
  }

  return null;
}

async function markReminded(issueId) {
  await supabase.rpc('increment_reminder_count', { p_issue_id: issueId });

  const { error } = await supabase
    .from('issues')
    .update({ last_reminded_at: new Date().toISOString() })
    .eq('id', issueId);

  if (error) console.error('markReminded error:', error.message);
}

async function getStaleIssues() {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('issues')
    .select('*')
    .in('status', ['open', 'acknowledged'])
    .lt('updated_at', cutoff)
    .lt('reminder_count', 3);

  if (error) {
    console.error('getStaleIssues error:', error.message);
    return [];
  }
  return data || [];
}

// ── Multi-user thread support ─────────────────────────────────────────

/**
 * Find an existing issue for a specific user in a specific thread.
 * Returns null if no issue exists for that user in that thread.
 */
async function findIssueForAuthorInThread(threadId, authorDiscordId) {
  const { data, error } = await supabase
    .from('issues')
    .select('*')
    .eq('thread_id', threadId)
    .eq('user_discord_id', authorDiscordId)
    .not('status', 'in', '(resolved,closed)')
    .maybeSingle();

  if (error) {
    console.error('[findIssueForAuthorInThread] error:', error.message);
    return null;
  }
  return data;
}

/**
 * Get ALL issues linked to a thread (for multi-user thread brief).
 * Returns array sorted by created_at ascending (original first).
 */
async function getAllThreadIssues(threadId) {
  const { data, error } = await supabase
    .from('issues')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[getAllThreadIssues] error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Create a linked sub-issue for a participant in an existing thread.
 * Shares the same thread_id but has its own issue ID, status, and history.
 */
async function createLinkedIssue({ user, guild, thread, title, description, parentIssue }) {
  await upsertUser(user);

  const department = await detectDepartment(`${title} ${description}`);

  const { data: idData, error: idError } = await supabase
    .rpc('generate_short_id');

  if (idError) {
    console.error('generate_short_id error:', idError.message);
    throw new Error('Could not generate issue ID');
  }

  const { data, error } = await supabase
    .from('issues')
    .insert({
      short_id:        idData,
      user_discord_id: user.id,
      guild_id:        guild.id,
      channel_id:      parentIssue.channel_id,
      department,
      title,
      description,
      steps_tried:     null,
      status:          'open',
      thread_id:       thread.id     // same thread, different user
    })
    .select()
    .single();

  if (error) {
    console.error('createLinkedIssue error:', error.message);
    throw new Error('Could not save linked issue to database');
  }

  await logStatus({
    issueId:   data.id,
    oldStatus: null,
    newStatus: 'open',
    changedBy: user.id,
    note:      `Sub-issue created in thread of ${parentIssue.short_id}`
  });

  await supabase.rpc('increment_open_issues', { p_discord_id: user.id });

  console.log(`[createLinkedIssue] ${data.short_id} created for ${user.username} in thread of ${parentIssue.short_id}`);
  return data;
}

// ── Phase & evidence state management ────────────────────────────────────────
// These are used by agent.js to manage the evidence-gathering state machine.

/**
 * Record that this issue's role has been pinged in its thread.
 * Used by forward.js to enforce one-ping-per-issue.
 */
async function markRolePinged(issueId) {
  const { error } = await supabase
    .from('issues')
    .update({ role_pinged_at: new Date().toISOString() })
    .eq('id', issueId);

  if (error) console.error('[markRolePinged] error:', error.message);
}

/**
 * Returns true if this issue's role has already been pinged once.
 */
async function hasBeenPinged(issueId) {
  const { data, error } = await supabase
    .from('issues')
    .select('role_pinged_at')
    .eq('id', issueId)
    .single();

  if (error) {
    console.error('[hasBeenPinged] error:', error.message);
    return false; // fail open — allow ping if unsure
  }
  return !!data?.role_pinged_at;
}

/**
 * Update the phase of an issue.
 * Valid phases: 'triage' | 'gathering' | 'escalated'
 */
async function setPhase(issueId, phase) {
  const { error } = await supabase
    .from('issues')
    .update({ phase, updated_at: new Date().toISOString() })
    .eq('id', issueId);

  if (error) console.error(`[setPhase] error setting phase=${phase}:`, error.message);
  else console.log(`[setPhase] issueId=${issueId} → phase=${phase}`);
}

/**
 * Fetch fresh evidence and phase for an issue from the database.
 * Used by agent.js at the start of each message to get the current state.
 */
async function fetchIssueEvidence(issueId) {
  const { data, error } = await supabase
    .from('issues')
    .select('phase, evidence')
    .eq('id', issueId)
    .single();

  if (error) {
    console.error('[fetchIssueEvidence] error:', error.message);
    return { phase: 'triage', evidence: {} };
  }
  return {
    phase:    data?.phase    || 'triage',
    evidence: data?.evidence || {}
  };
}

module.exports = {
  upsertUser,
  createIssue,
  attachThread,
  saveMessage,
  getIssueByShortId,
  getUserOpenIssues,
  updateStatus,
  isAtIssueLimit,
  findSimilarOpenIssue,
  markReminded,
  getStaleIssues,
  findIssueForAuthorInThread,
  getAllThreadIssues,
  createLinkedIssue,
  // Phase & evidence state
  markRolePinged,
  hasBeenPinged,
  setPhase,
  fetchIssueEvidence,
};
