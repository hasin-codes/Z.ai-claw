// supabase/functions/cleaning-cron/index.ts
// Supabase Edge Function — cleans raw community messages and inserts into the clean table.
// Triggered every 5 minutes by pg_cron (see sql/setup_cron_jobs.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const BATCH_SIZE = 500;

// --- Noise filters (mirrors lib/cleaning/noiseFilters.js) ---
const URL_ONLY = /^https?:\/\/\S+$/i;
const EMOJI_ONLY = /^[\p{Emoji}\s]+$/u;
const COMMAND_PREFIX = /^[!/.][\w-]+/;
const BOT_PATTERNS = [
  /^<@!?\d+>/,           // mentions only
  /^gg$/i,               // low effort
  /^\+\d+$/,             // +1 style
  /^(lol|lmao|rofl|kek|xd|haha|hehe)$/i,
];

function isNoise(msg: { content: string; user_id: string }, seen: { user_id: string; content: string }[]): boolean {
  const c = (msg.content || "").trim();
  if (!c || c.length < 3) return true;
  if (URL_ONLY.test(c)) return true;
  if (EMOJI_ONLY.test(c)) return true;
  if (COMMAND_PREFIX.test(c)) return true;
  for (const p of BOT_PATTERNS) {
    if (p.test(c)) return true;
  }
  // Duplicate detection
  for (const s of seen) {
    if (s.user_id === msg.user_id && s.content === c) return true;
  }
  return false;
}

// --- Text normalization (mirrors lib/cleaning/normalizeText.js) ---
function normalize(text: string): string {
  let t = text;
  // Strip Discord markdown
  t = t.replace(/\*{1,3}(.*?)\*{1,3}/g, "$1");
  t = t.replace(/_{1,2}(.*?)_{1,2}/g, "$1");
  t = t.replace(/~~(.*?)~~/g, "$1");
  t = t.replace(/`{1,3}[^`]*`{1,3}/g, "");
  // Strip mentions
  t = t.replace(/<@!?\d+>/g, "");
  t = t.replace(/<#\d+>/g, "");
  t = t.replace(/<@&\d+>/g, "");
  // Strip custom emoji
  t = t.replace(/<a?:\w+:\d+>/g, "");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

Deno.serve(async (_req) => {
  try {
    // Get cursor: highest message_id in clean table
    const { data: lastCleaned } = await supabase
      .from("community_messages_clean")
      .select("message_id")
      .order("message_id", { ascending: false })
      .limit(1)
      .maybeSingle();

    let query = supabase
      .from("community_messages")
      .select("message_id, channel_id, user_id, username, content, timestamp")
      .order("message_id", { ascending: true })
      .limit(BATCH_SIZE);

    if (lastCleaned?.message_id) {
      query = query.gt("message_id", lastCleaned.message_id);
    }

    const { data: rawMessages, error } = await query;
    if (error) throw new Error(`Fetch uncleaned failed: ${error.message}`);

    if (!rawMessages || rawMessages.length === 0) {
      return new Response(
        JSON.stringify({ status: "ok", fetched: 0, inserted: 0, removed: 0 }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const cleanRows: any[] = [];
    const seen: { user_id: string; content: string }[] = [];
    let removed = 0;

    for (const msg of rawMessages) {
      if (isNoise(msg, seen)) {
        removed++;
        continue;
      }
      const normalized = normalize(msg.content);
      if (!normalized) {
        removed++;
        continue;
      }

      cleanRows.push({
        message_id: msg.message_id,
        channel_id: msg.channel_id,
        user_id: msg.user_id,
        username: msg.username,
        content: normalized,
        timestamp: msg.timestamp,
      });

      seen.push({ user_id: msg.user_id, content: msg.content });
    }

    if (cleanRows.length > 0) {
      const { error: insertErr } = await supabase
        .from("community_messages_clean")
        .upsert(cleanRows, { onConflict: "message_id" });

      if (insertErr) throw new Error(`Insert clean failed: ${insertErr.message}`);
    }

    console.log(
      `[cleaning] Fetched: ${rawMessages.length} | Removed: ${removed} | Inserted: ${cleanRows.length}`
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        fetched: rawMessages.length,
        removed,
        inserted: cleanRows.length,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[cleaning] Failed:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
