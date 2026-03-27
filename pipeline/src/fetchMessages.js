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

  // Temporary Cloudflare Free Tier Fix:
  // Instead of fetching all history, fetch the latest 5000 messages if LIMIT_HISTORY is true
  const forceLimit = process.env.LIMIT_HISTORY !== 'false'; // Defaults to restricting unless explicitly 'false'

  if (!startTime && !endTime && forceLimit) {
    logger.info('fetchMessages', 'Cloudflare Free-Tier Mode: Limiting "ALL" mode to latest 5000 messages');
    let query = supabase
      .from('community_messages_clean')
      .select(COLUMNS)
      .order('id', { ascending: false })
      .limit(5000);

    if (channelId) query = query.eq('channel_id', channelId);

    const { data, error } = await query;
    if (error) throw new Error(`fetchMessages Supabase error: ${error.message} (code: ${error.code})`);

    allMessages = data || [];
    allMessages.reverse(); // Put them back in chronological order (oldest -> newest)
  } else {
    // Standard incremental logic for regular 12-hour background runs
    let lastId = 0;
    while (hasMore) {
      let query = supabase
        .from('community_messages_clean')
        .select(COLUMNS)
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(chunkSize);

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

      allMessages = allMessages.concat(data);
      lastId = data[data.length - 1].id;

      if (data.length < chunkSize) {
        hasMore = false;
      }
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

module.exports = { fetchMessages };
