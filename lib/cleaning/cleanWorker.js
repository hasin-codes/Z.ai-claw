const supabase = require('../supabase');
const { isNoise } = require('./noiseFilters');
const { normalize } = require('./normalizeText');

const RAW_TABLE = 'community_messages';
const CLEAN_TABLE = 'community_messages_clean';
const BATCH_SIZE = 500;

/**
 * Fetch a batch of unprocessed messages from the raw ingestion table.
 * Uses NOT EXISTS to skip messages already in the clean table.
 * @returns {Promise<Array<object>>}
 */
async function fetchUncleanedBatch() {
  const { data, error } = await supabase
    .from(RAW_TABLE)
    .select('message_id, channel_id, user_id, username, content, timestamp')
    .not('message_id', 'in', `(SELECT message_id FROM ${CLEAN_TABLE})`)
    .order('timestamp', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    throw new Error(`Failed to fetch uncleaned batch: ${error.message}`);
  }

  return data || [];
}

/**
 * Process a single batch: filter noise, normalize, and bulk insert.
 * @returns {Promise<{fetched: number, removed: number, inserted: number}>}
 */
async function processBatch() {
  const rawMessages = await fetchUncleanedBatch();

  if (!rawMessages.length) {
    return { fetched: 0, removed: 0, inserted: 0 };
  }

  const cleanRows = [];
  const seenMessages = []; // for duplicate detection across the batch
  let removed = 0;

  for (const msg of rawMessages) {
    const { isNoise: noise, reason } = isNoise(msg, seenMessages);

    if (noise) {
      removed++;
      continue;
    }

    const normalizedContent = normalize(msg.content);

    // If normalization wiped the content entirely, skip it
    if (!normalizedContent) {
      removed++;
      continue;
    }

    cleanRows.push({
      message_id: msg.message_id,
      channel_id: msg.channel_id,
      user_id: msg.user_id,
      username: msg.username,
      content: normalizedContent,
      timestamp: msg.timestamp,
    });

    // Track for duplicate detection in subsequent messages
    seenMessages.push({
      user_id: msg.user_id,
      content: msg.content,
      timestamp: msg.timestamp,
    });
  }

  // Bulk insert cleaned messages
  if (cleanRows.length > 0) {
    const { error } = await supabase
      .from(CLEAN_TABLE)
      .upsert(cleanRows, { onConflict: 'message_id' });

    if (error) {
      throw new Error(`Failed to insert clean batch: ${error.message}`);
    }
  }

  return {
    fetched: rawMessages.length,
    removed,
    inserted: cleanRows.length,
  };
}

/**
 * Run one cleaning cycle. Wraps in try/catch to never crash the worker.
 * @returns {Promise<{fetched: number, removed: number, inserted: number}|null>}
 */
async function runCycle() {
  try {
    console.log('[cleaning] Clean batch started');
    const stats = await processBatch();
    console.log(
      `[cleaning] Messages fetched: ${stats.fetched} | Removed as noise: ${stats.removed} | Inserted clean messages: ${stats.inserted}`
    );
    return stats;
  } catch (err) {
    console.error(`[cleaning] Batch failed: ${err.message}`);
    return null;
  }
}

module.exports = { fetchUncleanedBatch, processBatch, runCycle };
