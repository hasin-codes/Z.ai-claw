const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

// Use SUPABASE_SERVICE_KEY for write-capable access (pipeline writes to cluster tables)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Columns from community_messages_clean table (ground truth: sql/community_messages_clean.sql)
const COLUMNS = 'id, message_id, channel_id, user_id, username, content, timestamp';

/**
 * Fetch cleaned messages from Supabase for the batch window.
 * Uses cursor-based pagination by `id` (BIGSERIAL, guaranteed monotonic).
 * 
 * If GENERAL_CHAT_CHANNEL_ID is not set, fetches from ALL channels.
 * If startTime is null, fetches ALL messages (no time window — used for first run
 * when existing data is already in the table).
 *
 * @param {string|null} startTime - ISO timestamp for window start, or null for all
 * @param {string|null} endTime   - ISO timestamp for window end, or null for all
 * @returns {Promise<Array>} chronologically sorted message objects
 */
async function fetchMessages(startTime, endTime) {
  const channelId = process.env.GENERAL_CHAT_CHANNEL_ID;
  const chunkSize = PIPELINE_CONFIG.FETCH_CHUNK_SIZE;
  const backfillHours = process.env.PIPELINE_BACKFILL_HOURS
    ? parseInt(process.env.PIPELINE_BACKFILL_HOURS, 10)
    : PIPELINE_CONFIG.BATCH_WINDOW_HOURS;

  let allMessages = [];
  let lastId = 0;
  let hasMore = true;

  const mode = startTime ? `backfill: ${backfillHours}h` : 'ALL (no time filter)';
  logger.info('fetchMessages', `Fetching messages (${mode}, channel: ${channelId || 'ALL'})`);

  // LIMIT_HISTORY: if not 'false', caps "ALL" mode to latest 2000 messages
  // When LIMIT_HISTORY=false, fetches everything with no cap (paginated loop handles it)
  const forceLimit = process.env.LIMIT_HISTORY !== 'false';
  const maxMessages = forceLimit ? 2000 : Infinity;

  if (!startTime && !endTime && forceLimit) {
    logger.info('fetchMessages', `ALL mode capped at ${maxMessages} messages (set LIMIT_HISTORY=false to lift)`);
  }

  // Unified paginated fetch — works for both capped and uncapped, both timed and ALL modes
  // FIXED: Fetch from highest ID downward to get LATEST messages first
  while (hasMore) {
    let query = supabase
      .from('community_messages_clean')
      .select(COLUMNS)
      .order('id', { ascending: false })
      .limit(chunkSize);

    // For first iteration (lastId=0), no ID filter - just get newest messages
    // For subsequent iterations, get messages older than last fetched ID
    if (lastId > 0) {
      query = query.lt('id', lastId);
    }

    if (channelId) query = query.eq('channel_id', channelId);
    if (startTime) query = query.gte('timestamp', startTime);
    if (endTime) query = query.lt('timestamp', endTime);

    const { data, error } = await query;

    if (error) {
      throw new Error(`fetchMessages Supabase error: ${error.message} (code: ${error.code})`);
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    // Prepend to maintain chronological order (since we're fetching newest first)
    allMessages = [...data.reverse(), ...allMessages];
    lastId = data[data.length - 1].id;

    if (data.length < chunkSize) {
      hasMore = false;
    }

    // Stop early if we've hit the cap
    if (allMessages.length >= maxMessages) {
      allMessages = allMessages.slice(0, maxMessages);
      hasMore = false;
    }
  }

  logger.info('fetchMessages', `Fetched ${allMessages.length} messages`, {
    startTime: startTime || 'ALL',
    endTime: endTime || 'ALL',
    channelId: channelId || 'ALL',
    chunks: Math.ceil(allMessages.length / chunkSize) || 0,
  });

  return allMessages;
}

/**
 * Group messages by calendar date (UTC).
 * Each date bucket contains messages from 00:00:00 to 23:59:59 UTC.
 *
 * @param {Array} messages - Array of message objects with `timestamp` field
 * @returns {Map<string, Array>} Map of date string (YYYY-MM-DD) → messages for that date
 */
function groupMessagesByDate(messages) {
  const dateGroups = new Map();

  for (const msg of messages) {
    // Extract date from timestamp (UTC)
    const dateStr = msg.timestamp.split('T')[0]; // "2026-03-24" from "2026-03-24T14:27:12.632+00:00"

    if (!dateGroups.has(dateStr)) {
      dateGroups.set(dateStr, []);
    }
    dateGroups.get(dateStr).push(msg);
  }

  // Sort dates chronologically
  const sortedDates = Array.from(dateGroups.keys()).sort();
  const sortedMap = new Map();
  for (const date of sortedDates) {
    sortedMap.set(date, dateGroups.get(date));
  }

  logger.info('fetchMessages', `Grouped messages into ${sortedMap.size} date buckets`, {
    dates: sortedDates,
    messagesPerDate: sortedDates.map(d => ({
      date: d,
      count: dateGroups.get(d).length,
    })),
  });

  return sortedMap;
}

module.exports = { fetchMessages, groupMessagesByDate };
