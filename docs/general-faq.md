# General FAQ — Knowledge Base

---

## How do I set up the GLM API for use with coding extensions like Kilo Code?

**Problem description:**
Users trying to use GLM API with coding extensions (Kilo Code, OpenCode, Claude Code, etc.) receive errors even though they have an API key. The extensions fail to connect or return authentication errors, causing confusion about whether a paid Coding Plan is required.

**Solution:**
You do **not** need to buy a Coding Plan to use the GLM API. Z.ai offers two different API usage modes, and the issue is usually caused by the Base URL (API Endpoint) configuration not matching your account's payment setup.

**Configuration Option 1: Pay-as-you-go (No Coding Plan required)**
If you haven't bought a Coding Plan:
1. Top up a small cash balance in your account
2. Set the Base URL in your extension to the standard common endpoint:
   ```
   https://api.z.ai/api/paas/v4
   ```
3. You will be charged per request from your cash balance

**Configuration Option 2: Coding Plan Subscription**
If you have a Coding Plan (Lite/Pro/Max):
1. You must use the dedicated coding endpoint
2. Set the Base URL in your extension to:
   ```
   https://api.z.ai/api/coding/paas/v4
   ```
3. Requests will use your subscription quota, not cash balance

**Important Notes:**
- If you have a Coding Plan but use the standard endpoint (`/api/paas/v4`), the system will try to charge your cash balance and give you error `1113` "Insufficient balance"
- Make sure your Kilo Code extension is updated to the latest version
- Paste your API key without any hidden spaces
- Verify your API key is active in your account settings

**Common Error Codes:**
- `1113` - Insufficient balance (usually wrong endpoint for your plan type)
- `401` - Invalid API key (check for spaces or expired key)
- `429` - Rate limit reached (see API Rate Limiting documentation)

---
