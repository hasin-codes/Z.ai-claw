const path = require('path');
const { randomUUID } = require('crypto');

// Load .env for local development (safe no-op on Railway where vars are injected)
try { require('dotenv').config(); } catch { }

const { PIPELINE_CONFIG } = require('../pipeline.config');
const logger = require('./logger');
const batchTracker = require('./batchTracker');
const { fetchMessages } = require('./fetchMessages');
const { detectBoundariesPipeline } = require('./boundaryDetection');
const { classifyPipeline } = require('./classifier');
const { storeSegmentClassifications } = require('./storeResults');
const { buildContextBlocks } = require('./contextBuilder');
const { embedContextBlocks } = require('./embedder');
const qdrantClient = require('./qdrantClient');

/**
 * Validate required environment variables at startup.
 */
function validateEnv() {
  const missing = PIPELINE_CONFIG.REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      `See pipeline/README.md for setup instructions.`
    );
  }
}

/**
 * Best-effort: embed context blocks and upsert to Qdrant for retrieval.
 * Non-blocking — failures are logged but do not crash the pipeline.
 */
async function bestEffortEmbedAndIndex(segments) {
  try {
    const contextBlocks = buildContextBlocks(segments);
    if (contextBlocks.length === 0) {
      logger.info('orchestrator', 'No context blocks for Qdrant indexing');
      return;
    }

    const embeddedBlocks = await embedContextBlocks(contextBlocks);
    const validBlocks = embeddedBlocks.filter(b => !b.embeddingFailed);
    if (validBlocks.length === 0) {
      logger.warn('orchestrator', 'All embeddings failed — skipping Qdrant indexing');
      return;
    }

    const batchId = 'embed-' + randomUUID();
    await qdrantClient.upsertBlocks(validBlocks, batchId);

    logger.info('orchestrator', 'Qdrant indexing complete', {
      contextBlockCount: validBlocks.length,
      embeddingFailures: embeddedBlocks.length - validBlocks.length,
    });
  } catch (err) {
    // Non-blocking: log and continue — LLM classification is the primary path
    logger.warn('orchestrator', 'Qdrant indexing failed (non-blocking)', {
      error: err.message,
    });
  }
}

/**
 * Main pipeline orchestrator.
 *
 * Primary path: fetch → segment → LLM classify → store to Supabase
 * Secondary path (best-effort): embed → Qdrant upsert for retrieval
 *
 * On first run (no previous batch in Redis / degraded mode), fetches ALL
 * existing messages from community_messages_clean without a time window.
 * Subsequent runs use time-window-based incremental processing.
 */
async function runPipeline() {
  validateEnv();

  const batchId = randomUUID();
  logger.setBatchId(batchId);

  const startTime = Date.now();

  // Initialize Redis (fails gracefully into degraded mode)
  await batchTracker.initRedis();

  // Acquire distributed lock
  const locked = await batchTracker.acquireLock();
  if (!locked) {
    logger.warn('orchestrator', 'Pipeline lock already held — another instance is running. Exiting.');
    return;
  }

  // Record batch status
  const startedAt = new Date().toISOString();
  await batchTracker.setBatchStatus(batchId, 'running', startedAt);

  try {
    // Determine time window
    const lastBatch = await batchTracker.getLastBatch();
    let startTimeISO;
    let endTimeISO;

    if (lastBatch && lastBatch.endTimestamp) {
      // Normal incremental run — process messages since last batch
      startTimeISO = lastBatch.endTimestamp;
      endTimeISO = new Date().toISOString();
      logger.info('orchestrator', 'Incremental run since last batch', {
        startTimeISO, endTimeISO,
      });
    } else {
      // FIRST RUN or degraded mode (no Redis) — process ALL existing data
      // Don't guess a time window; just fetch everything in the clean table
      startTimeISO = null;
      endTimeISO = null;
      logger.info('orchestrator', 'First run — fetching ALL existing cleaned messages (no time filter)');
    }

    logger.info('orchestrator', 'Pipeline started', {
      timeWindow: { start: startTimeISO || 'ALL', end: endTimeISO || 'ALL' },
      degraded: batchTracker.isDegraded(),
    });

    // Step 1: Fetch messages
    const messages = await fetchMessages(startTimeISO, endTimeISO);

    if (messages.length === 0) {
      logger.info('orchestrator', 'No messages to process');
      // Only record endTimestamp if we had a real time window
      if (endTimeISO) {
        await batchTracker.setLastBatch(batchId, endTimeISO);
      }
      await batchTracker.setBatchStatus(batchId, 'done', startedAt, new Date().toISOString());
      return;
    }

    logger.info('orchestrator', `Processing ${messages.length} messages`);

    // Step 2: Boundary detection → segments
    const segments = await detectBoundariesPipeline(messages);

    if (segments.length === 0) {
      logger.info('orchestrator', 'No segments produced');
      const nowISO = new Date().toISOString();
      await batchTracker.setLastBatch(batchId, nowISO);
      await batchTracker.setBatchStatus(batchId, 'done', startedAt, nowISO);
      return;
    }

    // Step 3: LLM sub-topic classification (PRIMARY PATH)
    const classifications = await classifyPipeline(segments);

    // Step 4: Store classifications to Supabase
    const { clusterRows, messageRows } = await storeSegmentClassifications(
      classifications, segments, batchId
    );

    // Step 5: Best-effort embed + Qdrant indexing (non-blocking)
    await bestEffortEmbedAndIndex(segments);

    // Success — update tracking
    // Use the latest timestamp from the data we just processed
    const lastMsgTimestamp = messages[messages.length - 1]?.timestamp || new Date().toISOString();
    const durationMs = Date.now() - startTime;
    await batchTracker.setLastBatch(batchId, lastMsgTimestamp);
    await batchTracker.setBatchStatus(batchId, 'done', startedAt, new Date().toISOString());

    logger.info('orchestrator', 'Pipeline complete', {
      durationMs,
      messageCount: messages.length,
      segmentCount: segments.length,
      topicClusters: clusterRows,
      messageRows,
    });

  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error('orchestrator', 'Pipeline failed', {
      error: err.message,
      stack: err.stack?.slice(0, 1000),
      durationMs,
    });
    await batchTracker.setBatchStatus(batchId, 'failed', startedAt, new Date().toISOString());
    throw err;
  } finally {
    // ALWAYS release lock — even on crash
    await batchTracker.releaseLock();
    await batchTracker.close();
  }
}

// Run if executed directly
if (require.main === module) {
  runPipeline().catch((err) => {
    // Error already logged by orchestrator
    process.exitCode = 1;
  });
}

module.exports = { runPipeline };
