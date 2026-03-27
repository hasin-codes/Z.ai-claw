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
 *
 * @param {string} startTime - ISO timestamp for window start
 * @param {string} endTime   - ISO timestamp for window end
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

  logger.info('fetchMessages', `Fetching messages (backfill: ${backfillHours}h, channel: ${channelId || 'ALL'})`);

  while (hasMore) {
    let query = supabase
      .from('community_messages_clean')
      .select(COLUMNS)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(chunkSize);

    // Only filter by channel if GENERAL_CHAT_CHANNEL_ID is set
    if (channelId) {
      query = query.eq('channel_id', channelId);
    }

    // Apply time window
    query = query.gte('timestamp', startTime).lt('timestamp', endTime);

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

  logger.info('fetchMessages', `Fetched ${allMessages.length} messages`, {
    startTime,
    endTime,
    channelId: channelId || 'ALL',
    chunks: Math.ceil(allMessages.length / chunkSize) || 0,
  });

  return allMessages;
}

module.exports = { fetchMessages };
