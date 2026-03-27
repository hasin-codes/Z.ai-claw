// supabase/functions/pipeline-cron/index.ts
// Supabase Edge Function — runs the semantic analysis pipeline on a schedule.
// Triggered by pg_cron every 12 hours (see sql/setup_cron_jobs.sql).
//
// This function calls back into the bot's pipeline endpoint or runs the
// pipeline logic directly via Supabase's JS client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CF_ACCOUNT_ID = Deno.env.get("CF_ACCOUNT_ID")!;
const CF_API_TOKEN = Deno.env.get("CF_API_TOKEN")!;

const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

// --- Supabase client ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Cloudflare AI helpers ---
async function callCfEmbedding(texts: string[]): Promise<number[][]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CF_API_TOKEN}`,
      },
      body: JSON.stringify({ text: texts }),
    }
  );
  if (!res.ok) throw new Error(`CF embedding failed: ${res.status}`);
  const json = await res.json();
  return json.result.data;
}

async function callCfChat(
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CF_API_TOKEN}`,
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
      }),
    }
  );
  if (!res.ok) throw new Error(`CF chat failed: ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

// --- Fetch cleaned messages ---
interface CleanMessage {
  id: number;
  message_id: string;
  channel_id: string;
  user_id: string;
  username: string;
  content: string;
  timestamp: string;
}

async function fetchAllCleanedMessages(): Promise<CleanMessage[]> {
  const CHUNK = 1000;
  let all: CleanMessage[] = [];
  let lastId = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("community_messages_clean")
      .select("id, message_id, channel_id, user_id, username, content, timestamp")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(CHUNK);

    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;

    all = all.concat(data);
    lastId = data[data.length - 1].id;
    if (data.length < CHUNK) hasMore = false;
  }

  return all;
}

// --- Fetch messages with time window ---
async function fetchMessagesSince(since: string): Promise<CleanMessage[]> {
  const CHUNK = 1000;
  let all: CleanMessage[] = [];
  let lastId = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("community_messages_clean")
      .select("id, message_id, channel_id, user_id, username, content, timestamp")
      .gt("id", lastId)
      .gte("timestamp", since)
      .order("id", { ascending: true })
      .limit(CHUNK);

    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;

    all = all.concat(data);
    lastId = data[data.length - 1].id;
    if (data.length < CHUNK) hasMore = false;
  }

  return all;
}

// --- Simple boundary detection (TextTiling-lite) ---
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function vecNorm(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? v : v.map((x) => x / mag);
}

function meanPool(vecs: number[][]): number[] {
  const dim = vecs[0].length;
  const r = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) r[i] += v[i];
  return r.map((x) => x / vecs.length);
}

interface Segment {
  segmentIndex: number;
  messages: CleanMessage[];
  boundaryScore: number | null;
  startTimestamp: string;
  endTimestamp: string;
}

async function detectBoundaries(messages: CleanMessage[]): Promise<Segment[]> {
  const k = 3; // window size
  const threshold = 0.15;
  const minSize = 3;
  const maxSize = 80;

  if (messages.length < 2 * k + 1) {
    return [
      {
        segmentIndex: 0,
        messages,
        boundaryScore: null,
        startTimestamp: messages[0]?.timestamp,
        endTimestamp: messages[messages.length - 1]?.timestamp,
      },
    ];
  }

  // Embed all messages in batches
  const embeddings = new Map<number, number[]>();
  const BATCH = 50;
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const texts = batch.map((m) => `${m.username}: ${m.content}`);
    const vecs = await callCfEmbedding(texts);
    for (let j = 0; j < vecs.length; j++) {
      embeddings.set(i + j, vecs[j]);
    }
    if (i + BATCH < messages.length) await new Promise((r) => setTimeout(r, 200));
  }

  // Compute similarity curve
  const len = messages.length;
  const scores = new Float64Array(len);
  for (let i = k; i <= len - k; i++) {
    const left: number[][] = [];
    for (let j = i - k; j < i; j++) left.push(embeddings.get(j)!);
    const right: number[][] = [];
    for (let j = i; j < i + k; j++) right.push(embeddings.get(j)!);
    scores[i] = dotProduct(vecNorm(meanPool(left)), vecNorm(meanPool(right)));
  }

  // Depth scoring + thresholding
  const depth = new Float64Array(len);
  for (let i = k; i <= len - k; i++) {
    let lp = -Infinity,
      rp = -Infinity;
    for (let j = Math.max(k, i - k); j <= i; j++) if (scores[j] > lp) lp = scores[j];
    for (let j = i; j <= Math.min(len - k, i + k); j++) if (scores[j] > rp) rp = scores[j];
    depth[i] = lp - scores[i] + (rp - scores[i]);
  }

  // Smoothing
  const smoothed = Array.from(depth);
  for (let i = 1; i < len - 1; i++) {
    smoothed[i] = (depth[i - 1] + depth[i] + depth[i + 1]) / 3;
  }

  // Find boundaries
  let rawBounds: number[] = [];
  for (let i = k; i <= len - k; i++) {
    if (smoothed[i] > threshold) rawBounds.push(i);
  }

  // Enforce min/max constraints
  const filtered: number[] = [];
  for (let i = 0; i < rawBounds.length; i++) {
    const b = rawBounds[i];
    const prev = filtered.length > 0 ? filtered[filtered.length - 1] : 0;
    const next = rawBounds[i + 1] ?? len;
    if (b - prev >= minSize && next - b >= minSize) filtered.push(b);
  }

  // Force split segments > maxSize
  const bounds: number[] = [];
  let prev = 0;
  for (const b of filtered) {
    if (b - prev > maxSize) {
      let pos = prev + maxSize;
      while (pos < b) {
        bounds.push(pos);
        pos += maxSize;
      }
    }
    bounds.push(b);
    prev = b;
  }
  if (len - prev > maxSize) {
    let pos = prev + maxSize;
    while (pos < len) {
      bounds.push(pos);
      pos += maxSize;
    }
  }

  // Build segments
  const segments: Segment[] = [];
  let segPrev = 0;
  for (const b of bounds) {
    const segMsgs = messages.slice(segPrev, b);
    if (segMsgs.length > 0) {
      segments.push({
        segmentIndex: segments.length,
        messages: segMsgs,
        boundaryScore: smoothed[b] ?? null,
        startTimestamp: segMsgs[0].timestamp,
        endTimestamp: segMsgs[segMsgs.length - 1].timestamp,
      });
    }
    segPrev = b;
  }
  const final = messages.slice(segPrev);
  if (final.length > 0) {
    segments.push({
      segmentIndex: segments.length,
      messages: final,
      boundaryScore: null,
      startTimestamp: final[0].timestamp,
      endTimestamp: final[final.length - 1].timestamp,
    });
  }

  return segments;
}

// --- LLM Classification ---
function extractJSON(text: string): string {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return m ? m[1].trim() : text.trim();
}

async function classifySegments(
  segments: Segment[]
): Promise<Map<number, string>> {
  // Pass 1: category discovery
  const sampleSize = Math.min(15, segments.length);
  const step = Math.max(1, Math.floor(segments.length / sampleSize));
  const sampled: Segment[] = [];
  for (let i = 0; i < segments.length && sampled.length < sampleSize; i += step) {
    sampled.push(segments[i]);
  }

  const sampleTexts = sampled
    .map((s) => {
      const msgs = s.messages
        .slice(0, 20)
        .map((m) => `${m.username}: ${m.content}`)
        .join("\n");
      return `--- Segment ${s.segmentIndex} ---\n${msgs}`;
    })
    .join("\n\n");

  const discoveryRaw = await callCfChat(
    "You are analyzing conversation segments from a Discord community. Discover the natural topic categories. Produce a JSON array of category strings (2-4 words each, aim for 8-15). Return ONLY the JSON array.",
    sampleTexts
  );
  const categories: string[] = JSON.parse(extractJSON(discoveryRaw));

  // Pass 2: classify all segments in batches
  const classifications = new Map<number, string>();
  const catList = categories.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const batchSize = 10;

  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const batchText = batch
      .map((s) => {
        const msgs = s.messages
          .slice(0, 20)
          .map((m) => `${m.username}: ${m.content}`)
          .join("\n");
        return `--- Segment ${s.segmentIndex} ---\n${msgs}`;
      })
      .join("\n\n");

    try {
      const raw = await callCfChat(
        `Classify each segment into ONE of these categories:\n${catList}\n\nReturn a JSON array of objects with "segmentIndex" and "category". Return ONLY the JSON array.`,
        batchText
      );
      const results: { segmentIndex: number; category: string }[] = JSON.parse(
        extractJSON(raw)
      );
      for (const r of results) {
        if (typeof r.segmentIndex === "number" && typeof r.category === "string") {
          classifications.set(r.segmentIndex, r.category.trim());
        }
      }
    } catch {
      for (const s of batch) classifications.set(s.segmentIndex, "uncategorized");
    }

    if (i + batchSize < segments.length) await new Promise((r) => setTimeout(r, 500));
  }

  // Fill gaps
  for (const s of segments) {
    if (!classifications.has(s.segmentIndex)) {
      classifications.set(s.segmentIndex, "uncategorized");
    }
  }

  return classifications;
}

// --- Store results ---
async function storeResults(
  classifications: Map<number, string>,
  segments: Segment[],
  batchId: string
) {
  // Group by topic label
  const labelGroups = new Map<string, Segment[]>();
  for (const seg of segments) {
    const label = classifications.get(seg.segmentIndex) || "uncategorized";
    if (!labelGroups.has(label)) labelGroups.set(label, []);
    labelGroups.get(label)!.push(seg);
  }

  const clusterRows: any[] = [];
  const messageRows: any[] = [];
  let clusterIdCounter = 0;

  for (const [topicLabel, groupSegs] of labelGroups) {
    const clusterId = clusterIdCounter++;
    const uniqueMsgIds = new Set<string>();
    const uniqueUserIds = new Set<string>();
    const bScores: number[] = [];
    let minTs = groupSegs[0].startTimestamp;
    let maxTs = groupSegs[0].endTimestamp;

    for (const seg of groupSegs) {
      if (seg.startTimestamp < minTs) minTs = seg.startTimestamp;
      if (seg.endTimestamp > maxTs) maxTs = seg.endTimestamp;
      if (seg.boundaryScore != null) bScores.push(seg.boundaryScore);
      for (const m of seg.messages) {
        uniqueMsgIds.add(m.message_id);
        if (m.user_id) uniqueUserIds.add(m.user_id);
      }
    }

    clusterRows.push({
      batch_id: batchId,
      cluster_id: clusterId,
      topic_label: topicLabel,
      start_timestamp: minTs,
      end_timestamp: maxTs,
      message_count: uniqueMsgIds.size,
      unique_users: uniqueUserIds.size,
      avg_boundary_score: bScores.length > 0 ? bScores.reduce((a, b) => a + b, 0) / bScores.length : null,
    });

    for (const seg of groupSegs) {
      for (const m of seg.messages) {
        messageRows.push({
          batch_id: batchId,
          cluster_id: clusterId,
          message_id: m.message_id,
          context_block_id: seg.segmentIndex.toString(),
          channel_id: m.channel_id || null,
          user_id: m.user_id || null,
        });
      }
    }
  }

  // Write clusters
  if (clusterRows.length > 0) {
    const { error } = await supabase.from("pipeline_clusters").insert(clusterRows);
    if (error) throw new Error(`Insert pipeline_clusters failed: ${error.message}`);
  }

  // Write messages in chunks
  for (let i = 0; i < messageRows.length; i += 500) {
    const chunk = messageRows.slice(i, i + 500);
    const { error } = await supabase.from("pipeline_cluster_messages").insert(chunk);
    if (error) throw new Error(`Insert pipeline_cluster_messages failed: ${error.message}`);
  }

  return { clusterRows: clusterRows.length, messageRows: messageRows.length };
}

// --- Get last pipeline run timestamp ---
async function getLastPipelineRun(): Promise<string | null> {
  const { data } = await supabase
    .from("pipeline_clusters")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at || null;
}

// --- Main handler ---
Deno.serve(async (req) => {
  try {
    const batchId = crypto.randomUUID();
    console.log(`[pipeline-cron] Starting batch ${batchId}`);

    // Check if we have previous runs
    const lastRun = await getLastPipelineRun();
    let messages: CleanMessage[];

    if (lastRun) {
      console.log(`[pipeline-cron] Incremental since ${lastRun}`);
      messages = await fetchMessagesSince(lastRun);
    } else {
      console.log("[pipeline-cron] First run — fetching all cleaned messages");
      messages = await fetchAllCleanedMessages();
    }

    if (messages.length === 0) {
      console.log("[pipeline-cron] No messages to process");
      return new Response(JSON.stringify({ status: "ok", messages: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`[pipeline-cron] Processing ${messages.length} messages`);

    // Step 1: Boundary detection
    const segments = await detectBoundaries(messages);
    console.log(`[pipeline-cron] ${segments.length} segments detected`);

    if (segments.length === 0) {
      return new Response(JSON.stringify({ status: "ok", segments: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Step 2: LLM classification
    const classifications = await classifySegments(segments);
    console.log(`[pipeline-cron] ${classifications.size} classifications`);

    // Step 3: Store results
    const result = await storeResults(classifications, segments, batchId);
    console.log(
      `[pipeline-cron] Done: ${result.clusterRows} clusters, ${result.messageRows} messages`
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        batchId,
        messages: messages.length,
        segments: segments.length,
        ...result,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[pipeline-cron] Failed:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
