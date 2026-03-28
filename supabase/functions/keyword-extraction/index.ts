// Supabase Edge Function: Keyword Extraction
// Runs daily at midnight UTC via pg_cron scheduling
// Extracts top 5 keywords from Discord messages using YAKE algorithm
// Stores results in daily_keyword_insights table (date-wise, idempotent)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Initialize Supabase client
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Import YAKE via esm.sh CDN (Deno-compatible)
// Note: YAKE is a Node.js package, so we'll use a simple alternative for Deno
// We'll implement a lightweight keyword extraction directly

/**
 * Simple keyword extraction for Deno/Edge Functions
 * Implements basic TF-IDF-like scoring with stopword filtering
 */
function extractKeywords(text: string, limit: number = 20): Array<[string, number]> {
  // Stopwords list (comprehensive for Discord chat)
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
    'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'i', 'me',
    'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
    'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
    'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
    'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that',
    'these', 'those', 'am', 'and', 'but', 'if', 'or', 'because', 'until',
    'while', 'about', 'against', 'out', 'up', 'down', 'off', 'over', 'any'
  ]);

  // Tokenize: lowercase, split on non-word characters
  const words = text.toLowerCase().match(/\b[a-z]{3,30}\b/g) || [];
  
  // Filter stopwords
  const filtered = words.filter(w => !stopWords.has(w));
  
  // Count frequency
  const freq: Map<string, number> = new Map();
  filtered.forEach(word => {
    freq.set(word, (freq.get(word) || 0) + 1);
  });
  
  // Sort by frequency and return top N
  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  
  return sorted as Array<[string, number]>;
}

/**
 * Find the timestamp when keyword was most mentioned (peak hour)
 */
function findPeakTimestamp(messages: Array<{ timestamp: string }>): string {
  if (!messages || messages.length === 0) {
    return new Date().toISOString();
  }
  
  // Group by hour
  const hourlyCounts: Map<string, number> = new Map();
  messages.forEach(m => {
    if (!m.timestamp) return;
    const hour = m.timestamp.slice(0, 13); // "2026-03-24T14"
    hourlyCounts.set(hour, (hourlyCounts.get(hour) || 0) + 1);
  });
  
  if (hourlyCounts.size === 0) {
    return new Date().toISOString();
  }
  
  // Find peak hour
  let peakHour = '';
  let maxCount = 0;
  hourlyCounts.forEach((count, hour) => {
    if (count > maxCount) {
      maxCount = count;
      peakHour = hour;
    }
  });
  
  return `${peakHour}:00:00.000Z`;
}

/**
 * Find the channel where keyword was most mentioned
 */
function findPeakChannel(messages: Array<{ channel_id: string }>): string | null {
  if (!messages || messages.length === 0) {
    return null;
  }
  
  const channelCounts: Map<string, number> = new Map();
  messages.forEach(m => {
    if (!m.channel_id) return;
    channelCounts.set(m.channel_id, (channelCounts.get(m.channel_id) || 0) + 1);
  });
  
  if (channelCounts.size === 0) {
    return null;
  }
  
  let peakChannel = '';
  let maxCount = 0;
  channelCounts.forEach((count, channel) => {
    if (count > maxCount) {
      maxCount = count;
      peakChannel = channel;
    }
  });
  
  return peakChannel;
}

/**
 * Extract keywords from messages for a single date
 */
function extractKeywordsForDate(
  messages: Array<{ content: string; timestamp: string; channel_id: string }>
): Array<{
  keyword: string;
  mention_count: number;
  peak_timestamp: string;
  peak_channel_id: string | null;
}> {
  if (!messages || messages.length === 0) {
    return [];
  }
  
  // Combine all message content
  const allText = messages.map(m => m.content).join(' ');
  
  // Extract keywords (top 20 candidates)
  const keywords = extractKeywords(allText, 20);
  
  // Build stats for each keyword
  const keywordStats = keywords.map(([keyword, _score]) => {
    // Find all messages containing this keyword
    const matchingMessages = messages.filter(m =>
      m.content.toLowerCase().includes(keyword.toLowerCase())
    );
    
    return {
      keyword,
      mention_count: matchingMessages.length,
      peak_timestamp: findPeakTimestamp(matchingMessages),
      peak_channel_id: findPeakChannel(matchingMessages)
    };
  });
  
  // Sort by mention count and return top 5
  return keywordStats
    .sort((a, b) => b.mention_count - a.mention_count)
    .slice(0, 5);
}

/**
 * Validate date string (YYYY-MM-DD)
 */
function isValidDate(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;
  const date = new Date(dateStr + 'T00:00:00.000Z');
  return !isNaN(date.getTime());
}

// Main Edge Function handler
Deno.serve(async (req: Request) => {
  try {
    // Parse request body (may contain date parameter)
    let targetDate: string;
    
    try {
      const body = await req.json();
      targetDate = body.date;
    } catch {
      // Default to yesterday if no date provided
      const yesterday = new Date(Date.now() - 86400000);
      targetDate = yesterday.toISOString().split('T')[0];
    }
    
    // Validate date format
    if (!isValidDate(targetDate)) {
      return new Response(
        JSON.stringify({ 
          error: 'Invalid date format. Use YYYY-MM-DD' 
        }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    console.log(`[keyword-extraction] Processing keywords for date: ${targetDate}`);
    
    // Fetch all messages from that specific date (UTC 00:00 to 23:59:59)
    const { data: messages, error: fetchError } = await supabase
      .from('community_messages_clean')
      .select('content, timestamp, channel_id')
      .gte('timestamp', `${targetDate}T00:00:00.000Z`)
      .lt('timestamp', `${targetDate}T23:59:59.999Z`);
    
    if (fetchError) {
      console.error('[keyword-extraction] Fetch error:', fetchError);
      throw fetchError;
    }
    
    if (!messages || messages.length === 0) {
      console.log(`[keyword-extraction] No messages found for ${targetDate}`);
      return new Response(
        JSON.stringify({ 
          status: 'ok', 
          date: targetDate,
          keywords: 0,
          message: 'No messages for this date'
        }),
        { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    console.log(`[keyword-extraction] Processing ${messages.length} messages for ${targetDate}`);
    
    // Extract keywords (date-wise)
    const topKeywords = extractKeywordsForDate(messages);
    
    // Add date field to each keyword
    const keywordsWithDate = topKeywords.map(k => ({
      ...k,
      date: targetDate
    }));
    
    console.log(`[keyword-extraction] Top keywords for ${targetDate}:`, keywordsWithDate);
    
    // Delete existing keywords for this date (idempotent)
    const { error: deleteError } = await supabase
      .from('daily_keyword_insights')
      .delete()
      .eq('date', targetDate);
    
    if (deleteError) {
      console.error('[keyword-extraction] Delete error:', deleteError);
      throw deleteError;
    }
    
    // Insert new keywords
    const { error: insertError } = await supabase
      .from('daily_keyword_insights')
      .insert(keywordsWithDate);
    
    if (insertError) {
      console.error('[keyword-extraction] Insert error:', insertError);
      throw insertError;
    }
    
    console.log(`[keyword-extraction] Successfully stored ${keywordsWithDate.length} keywords for ${targetDate}`);
    
    return new Response(
      JSON.stringify({
        status: 'ok',
        date: targetDate,
        keywords: keywordsWithDate.length,
        data: keywordsWithDate
      }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
  } catch (err) {
    console.error('[keyword-extraction] Failed:', err);
    return new Response(
      JSON.stringify({ 
        error: (err as Error).message,
        stack: (err as Error).stack 
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
});
