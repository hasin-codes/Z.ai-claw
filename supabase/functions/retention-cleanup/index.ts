// supabase/functions/retention-cleanup/index.ts
// Supabase Edge Function — deletes raw messages older than 7 days that have been cleaned.
// Triggered daily by pg_cron (see sql/setup_cron_jobs.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const RETENTION_DAYS = 7;
const CHUNK_SIZE = 500;

Deno.serve(async (_req) => {
  try {
    const cutoff = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    console.log(`[retention] Deleting raw messages older than ${cutoff}`);

    let totalDeleted = 0;
    let hasMore = true;
    let lastId = "";

    while (hasMore) {
      // Fetch old raw messages
      let rawQuery = supabase
        .from("community_messages")
        .select("message_id, timestamp")
        .lt("timestamp", cutoff)
        .order("message_id", { ascending: true })
        .limit(CHUNK_SIZE);

      if (lastId) {
        rawQuery = rawQuery.gt("message_id", lastId);
      }

      const { data: oldRaw, error: err1 } = await rawQuery;
      if (err1) throw new Error(`Fetch raw failed: ${err1.message}`);
      if (!oldRaw || oldRaw.length === 0) break;

      lastId = oldRaw[oldRaw.length - 1].message_id;

      // Verify which exist in cleaned table
      const rawIds = oldRaw.map((r: any) => r.message_id);
      const { data: verified, error: err2 } = await supabase
        .from("community_messages_clean")
        .select("message_id")
        .in("message_id", rawIds);

      if (err2) throw new Error(`Verify failed: ${err2.message}`);

      if (verified && verified.length > 0) {
        const verifiedIds = verified.map((v: any) => v.message_id);

        // Delete verified old raw messages
        const { error: delErr } = await supabase
          .from("community_messages")
          .delete()
          .in("message_id", verifiedIds);

        if (delErr) throw new Error(`Delete failed: ${delErr.message}`);
        totalDeleted += verifiedIds.length;
      }

      if (oldRaw.length < CHUNK_SIZE) hasMore = false;
    }

    console.log(`[retention] Deleted ${totalDeleted} raw messages`);

    return new Response(
      JSON.stringify({ status: "ok", deleted: totalDeleted, cutoff }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[retention] Failed:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
