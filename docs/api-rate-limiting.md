# API Rate Limiting — Knowledge Base

---

## Why am I getting 429 rate limit errors even though I have usage quota remaining?

**Problem description:**
Users on paid plans (including Max plan) receive 429 rate limit errors with error code `1302` and message "Rate limit reached for requests" even when they have significant usage quota remaining (e.g., only 1% usage shown). This occurs during periods of high server traffic and is not related to the user's personal token usage quota.

**Solution:**
The 1302 Rate Limit error is a temporary, system-wide block caused by extreme server load and compute capacity limits, not your personal usage quota. When experiencing a massive surge in traffic, the system aggressively throttles concurrent connections to stay online.

**What to do:**
1. Wait for the server load to decrease and try again later
2. Reduce the number of concurrent requests in your application
3. Implement retry logic with exponential backoff in your code

The engineering team works to scale hardware and add compute capacity during these periods. The error is temporary and resolves once traffic decreases.

---

## Why am I getting "Insufficient balance" error when I have an active Coding Plan subscription?

**Problem description:**
Users with active GLM Coding Plan subscriptions (Lite/Pro/Max) receive error `1113` with message "Insufficient balance or no resource package. Please recharge." when making API requests through tools like OpenClaw, Claude Code, or other API clients. The API works via direct curl commands but fails in their configured tools.

**Solution:**
This is caused by using the wrong API endpoint. When you have a Coding Plan subscription, you **must** use the dedicated coding endpoint. If your tool is configured to use the standard common endpoint, the system bypasses your subscription and tries to charge your direct cash balance instead.

**Fix the configuration:**

Change your Base URL / API Endpoint to:
```
https://api.z.ai/api/coding/paas/v4
```

**Common incorrect endpoint (do not use with Coding Plan):**
```
https://api.z.ai/api/paas/v4
```

**For tools like OpenClaw, Claude Code, Kilo Code:**
- Go to your tool's configuration settings
- Find the Base URL or API Endpoint setting
- Replace with the coding endpoint above
- Save and restart the tool

---

## Why do I hit rate limits immediately when using multiple API keys?

**Problem description:**
Users on Pro plan receive 429 rate limit errors immediately upon starting to use the API, even when they believe they have not exceeded their quota. This commonly happens when users have multiple API keys active from previous sessions or experiments.

**Solution:**
All API keys on your account share the same rate limit quota. The Pro plan has a limit of 100 requests per minute **across all API keys combined**, not per key. If you have multiple active API keys (including old or unused ones), all requests from all keys count toward the same quota simultaneously.

**How to fix:**
1. Go to your API keys settings page at https://chat.z.ai or your account dashboard
2. Review all active API keys
3. Deactivate or delete any keys you are not actively using
4. Keep only the keys you need for current projects
5. Test with a single key to verify the issue is resolved

---
