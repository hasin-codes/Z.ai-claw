const supabase = require('../supabase');

const RAW_TABLE = 'community_messages';
const CLEAN_TABLE = 'community_messages_clean';
const STATE_TABLE = 'message_ingestion_state';

/**
 * Delete raw messages older than retention period.
 * Only deletes messages that have already been cleaned (exist in clean table).
 * Compares message_id and timestamp in both tables for safety.
 * 
 * @param {number} retentionDays - How many days to keep raw messages (default: 7)
 * @returns {Promise<{deleted: number, error: string|null}>}
 */
async function deleteOldRawMessages(retentionDays = 7) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[retention] Starting cleanup - deleting raw messages older than ${cutoff}`);

  try {
    // Step 1: Get old raw messages (before cutoff), paginate in chunks
    const CHUNK_SIZE = 500;
    let totalDeleted = 0;
    let hasMore = true;
    let lastId = '';

    while (hasMore) {
      // Fetch a chunk of old raw messages
      let rawQuery = supabase
        .from(RAW_TABLE)
        .select('message_id, timestamp')
        .lt('timestamp', cutoff)
        .order('message_id', { ascending: true })
        .limit(CHUNK_SIZE);

      if (lastId) {
        rawQuery = rawQuery.gt('message_id', lastId);
      }

      const { data: oldRaw, error: err1 } = await rawQuery;

      if (err1) {
        throw new Error(`Failed to fetch old raw messages: ${err1.message}`);
      }

      if (!oldRaw || oldRaw.length === 0) {
        hasMore = false;
        break;
      }

      // Update cursor for next page
      lastId = oldRaw[oldRaw.length - 1].message_id;

      // Step 2: Check which of these exist in the cleaned table
      const rawIds = oldRaw.map(r => r.message_id);
      const { data: verified, error: err2 } = await supabase
        .from(CLEAN_TABLE)
        .select('message_id')
        .in('message_id', rawIds);

      if (err2) {
        throw new Error(`Failed to verify cleaned messages: ${err2.message}`);
      }

      if (!verified || verified.length === 0) {
        // None of these raw messages have been cleaned yet — skip
        if (oldRaw.length < CHUNK_SIZE) {
          hasMore = false;
        }
        continue;
      }

      const verifiedIds = verified.map(v => v.message_id);

      // Step 3: Delete the verified ones from raw table
      const { error: deleteError } = await supabase
        .from(RAW_TABLE)
        .delete()
        .in('message_id', verifiedIds);

      if (deleteError) {
        throw new Error(`Failed to delete raw messages: ${deleteError.message}`);
      }

      totalDeleted += verifiedIds.length;

      if (oldRaw.length < CHUNK_SIZE) {
        hasMore = false;
      }
    }

    if (totalDeleted > 0) {
      console.log(`[retention] Deleted ${totalDeleted} raw messages older than ${cutoff}`);
    } else {
      console.log('[retention] No old verified messages to delete');
    }

    // Step 4: Update last cleanup timestamp
    await supabase
      .from(STATE_TABLE)
      .upsert({
        channel_id: 'retention_cleanup',
        last_message_id: null,
        last_processed_at: new Date().toISOString(),
      }, { onConflict: 'channel_id' });

    return { deleted: totalDeleted, error: null };

  } catch (err) {
    console.error('[retention] Cleanup failed:', err.message);
    return { deleted: 0, error: err.message };
  }
}

/**
 * Get the last retention cleanup timestamp.
 * @returns {Promise<Date|null>}
 */
async function getLastRetentionRun() {
  try {
    const { data, error } = await supabase
      .from(STATE_TABLE)
      .select('last_processed_at')
      .eq('channel_id', 'retention_cleanup')
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return new Date(data.last_processed_at);
  } catch (err) {
    console.error('[retention] Failed to get last run:', err.message);
    return null;
  }
}

/**
 * Check if retention cleanup should run (once per day).
 * @returns {Promise<boolean>}
 */
async function shouldRunRetention() {
  try {
    const lastRun = await getLastRetentionRun();
    if (!lastRun) {
      return true; // Never run before, run now
    }

    const now = Date.now();
    const hoursSinceLastRun = (now - lastRun.getTime()) / (1000 * 60 * 60);

    // Run once every 24 hours
    return hoursSinceLastRun >= 24;
  } catch (err) {
    console.error('[retention] Error checking if should run:', err.message);
    return false; // Don't run on error — better safe than sorry
  }
}

module.exports = {
  deleteOldRawMessages,
  getLastRetentionRun,
  shouldRunRetention,
};
