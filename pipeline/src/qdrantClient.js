const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.QDRANT_PIPELINE_COLLECTION;

/**
 * Ensure collection exists, create if not.
 */
async function ensureCollectionExists() {
  try {
    // Check if collection exists
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      headers: { 'api-key': QDRANT_API_KEY }
    });
    
    if (res.ok) {
      logger.info('qdrantClient', `Collection ${COLLECTION_NAME} exists`);
      return;
    }
    
    if (res.status === 404) {
      // Collection doesn't exist, create it
      logger.info('qdrantClient', `Creating collection ${COLLECTION_NAME}...`);
      
      const createRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'api-key': QDRANT_API_KEY,
        },
        body: JSON.stringify({
          vectors: {
            size: 1024, // BGE-Large embedding dimension
            distance: 'Cosine',
          },
        }),
      });
      
      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Failed to create collection: ${createRes.status} ${errText.slice(0, 300)}`);
      }
      
      logger.info('qdrantClient', `Collection ${COLLECTION_NAME} created successfully`);
    }
  } catch (err) {
    logger.error('qdrantClient', `Collection check/create failed: ${err.message}`);
    throw err;
  }
}

/**
 * Upsert context blocks into Qdrant in batches.
 *
 * @param {Array<{contextBlockId: string, vector: number[], anchorMessageId: string, segmentIndex: number, segmentBoundaryScore: number|null, messageIds: string[], channelId: string, startTimestamp: string, endTimestamp: string, contextText: string}>} blocks
 * @param {string} batchId
 */
async function upsertBlocks(blocks, batchId) {
  if (blocks.length === 0) return;
  
  // Ensure collection exists before upserting
  await ensureCollectionExists();

  const batchSize = PIPELINE_CONFIG.QDRANT_UPSERT_BATCH_SIZE;
  const maxRetries = PIPELINE_CONFIG.QDRANT_RETRY_COUNT;
  const retryDelay = PIPELINE_CONFIG.QDRANT_RETRY_DELAY_MS;
  let totalStored = 0;

  for (let i = 0; i < blocks.length; i += batchSize) {
    const chunk = blocks.slice(i, i + batchSize);
    const points = chunk.map(b => ({
      id: b.contextBlockId,
      vector: b.vector,
      payload: {
        anchorMessageId: b.anchorMessageId,
        segmentIndex: b.segmentIndex,
        segmentBoundaryScore: b.segmentBoundaryScore,
        messageIds: b.messageIds,
        channelId: b.channelId,
        startTimestamp: b.startTimestamp,
        endTimestamp: b.endTimestamp,
        contextText: b.contextText,
        batchId,
        pipelineVersion: 'v1-boundary-detection',
      },
    }));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'api-key': QDRANT_API_KEY,
          },
          body: JSON.stringify({ points }),
        });

        if (res.status === 429) {
          logger.warn('qdrantClient', `Rate limited, retry ${attempt}/${maxRetries}`);
          if (attempt === maxRetries) {
            throw new Error(`Qdrant 429 after ${maxRetries} retries`);
          }
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Qdrant upsert failed: ${res.status} ${errText.slice(0, 300)}`);
        }

        totalStored += chunk.length;
        break;
      } catch (err) {
        if (attempt === maxRetries) throw err;
        logger.warn('qdrantClient', `Upsert retry ${attempt}/${maxRetries}`, { error: err.message });
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }

  logger.info('qdrantClient', `Upserted ${totalStored} points`, { collection: COLLECTION_NAME });
}

/**
 * Fetch all vectors + payloads for a given batch ID from Qdrant.
 * Used by Step 6 (clustering).
 *
 * @param {string} batchId
 * @returns {Promise<Array<{id: string, vector: number[], payload: object}>>}
 */
async function fetchBatchPoints(batchId) {
  let allPoints = [];
  let offset = null;
  const limit = 500;

  // Scroll through all points matching the batch filter
  while (true) {
    const body = {
      limit,
      filter: {
        key: 'batchId',
        match: { value: batchId },
      },
      with_payload: true,
      with_vector: true,
    };
    if (offset) body.offset = offset;

    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': QDRANT_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Qdrant scroll failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    const json = await res.json();
    const points = json.result?.points || [];
    allPoints = allPoints.concat(points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    })));

    if (!json.result?.next_page_offset) break;
    offset = json.result.next_page_offset;
  }

  logger.info('qdrantClient', `Fetched ${allPoints.length} points for batch`, { batchId });
  return allPoints;
}

module.exports = { upsertBlocks, fetchBatchPoints, ensureCollectionExists };
