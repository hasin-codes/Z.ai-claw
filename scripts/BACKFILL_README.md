# Backfill Pipeline - Automatic Historical Data Processing

## What This Does

Processes **historical messages** from `community_messages_clean` table (all 67,880 messages) instead of just the last 12 hours.

---

## How It Works

### **Automatic on First Deploy**

When you deploy with `AUTO_BACKFILL=true`:

```
T+0s:   Bot starts
T+2min: Backfill starts (processes last 30 days)
T+2min: → Fetches 67,880 messages
T+2min: → Detects ~3,000 segments
T+2min: → LLM classifies into ~50-100 topics
T+2min: → LLM generates summaries for each topic
T+2min: → Writes to Supabase
T+2min: → Upserts to Qdrant
T+~40min: Backfill complete!
```

### **Then Regular Pipeline Continues**

```
T+3min: Regular pipeline runs (last 12 hours)
T+12h:  Regular pipeline runs again
T+24h:  Regular pipeline runs again
...
```

---

## Enable Backfill

### **Railway Dashboard → Variables → Add:**

```env
AUTO_BACKFILL=true
```

Then redeploy. Railway will:
1. Build and start bot
2. Wait 2 minutes
3. **Run backfill automatically**
4. Process all 67,880 messages
5. Continue with regular 12-hour pipeline

---

## What You'll See in Logs

```
[backfill] Running initial backfill pipeline...
[backfill] Processing last 30 days of messages...
[FETCH] Fetched 67880 messages
[BOUNDARY_DETECTION] Detected 3247 segments
[LLM_CLASSIFICATION] Discovered 87 categories
[storeResults] Generating LLM topic summaries...
[storeResults] Inserted 87 topic summaries
[qdrantClient] Creating collection community_messages_pipeline...
[qdrantClient] Upserted 65432 points
[backfill] Backfill complete!
```

---

## After Backfill Completes

### **Check Results in Supabase:**

```sql
-- How many topics created?
SELECT COUNT(*) FROM pipeline_clusters;
-- Expected: 50-100 topics

-- See top topics by message count
SELECT 
  topic_label,
  message_count,
  unique_users,
  sentiment,
  severity
FROM pipeline_clusters
ORDER BY message_count DESC
LIMIT 10;

-- See LLM summaries
SELECT 
  topic_label,
  LEFT(summary, 200) as summary_preview,
  sentiment,
  severity
FROM pipeline_topic_summaries
ORDER BY created_at DESC
LIMIT 10;

-- See messages in a specific topic
SELECT 
  m.username,
  m.content,
  m.timestamp
FROM pipeline_cluster_messages pcm
JOIN community_messages_clean m ON pcm.message_id = m.message_id
WHERE pcm.topic_label = 'GLM-5 Performance Issues'
ORDER BY m.timestamp ASC
LIMIT 20;
```

---

## Disable After First Run

Backfill automatically disables after first run. To prevent re-running:

**Railway Dashboard → Variables → Remove or Set:**
```env
AUTO_BACKFILL=false
```

Then redeploy.

---

## Re-Run Backfill (If Needed)

If you want to re-process historical data:

1. **Railway Dashboard → Variables → Set:**
   ```env
   AUTO_BACKFILL=true
   ```

2. **Redeploy** (Railway auto-redeploys on env var change)

3. Backfill runs again on next startup

---

## Customize Time Range

Want to process more/less than 30 days?

**Edit `scripts/backfill-pipeline.js`:**
```javascript
// Line 18:
process.env.PIPELINE_BACKFILL_HOURS = '720'; // 720 hours = 30 days

// Change to:
process.env.PIPELINE_BACKFILL_HOURS = '168'; // 7 days
// or
process.env.PIPELINE_BACKFILL_HOURS = '2160'; // 90 days
```

---

## Estimated Time & Cost

### **Time:**
- 67,880 messages ≈ **30-60 minutes**
- Most time spent on LLM API calls (rate limited)

### **Cost (Cloudflare Workers AI):**
- ~2.3M tokens for classification
- ~5M tokens for summaries
- **Total: ~$0.50-1.00** for one-time backfill

---

## Troubleshooting

### **Backfill doesn't start**

Check logs for:
```
[backfill] Running initial backfill pipeline...
```

If missing, check `AUTO_BACKFILL=true` is set in Railway.

### **Backfill fails with "Missing env vars"**

Add these to Railway Variables:
```env
SUPABASE_SERVICE_KEY=...
QDRANT_PIPELINE_COLLECTION=community_messages_pipeline
```

### **Backfill times out**

Railway has 10-minute timeout for individual operations, but backfill runs as background task so it won't timeout. Just wait 30-60 minutes.

---

## Summary

| Setting | Value |
|---------|-------|
| **Env Var** | `AUTO_BACKFILL=true` |
| **Runs** | Once on first deploy |
| **Processes** | Last 30 days (67,880 messages) |
| **Duration** | 30-60 minutes |
| **Cost** | ~$0.50-1.00 |
| **Auto-disables** | Yes, after first run |

---

**Set `AUTO_BACKFILL=true` in Railway and redeploy to process all 67,880 messages!** 🚀
