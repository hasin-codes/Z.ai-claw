# Account and Access — Knowledge Base

---

## How do I contact Z.ai support?

**Problem description:**
Users need to reach the Z.ai support team to resolve billing issues, technical problems, or account questions and are unsure of the correct channel to use.

**Solution:**
Z.ai support is handled through the Discord bad-case-report channel. Use the `/report` command in the Z.ai Discord server to file a support ticket. A team member will respond to your thread.

For billing issues, include your User ID and payment receipt when contacting support. For technical issues, include your API key (last 4 characters only), error codes, and steps to reproduce the problem.

---

## How do I get my Z.ai API key?

**Problem description:**
Users need an API key to use Z.ai with coding extensions like Kilo Code, Claude Code, or OpenCode and are unsure where to find or create one.

**Solution:**
API keys are managed in your Z.ai account dashboard at https://chat.z.ai. Go to your account settings and navigate to the API keys section to create, view, or deactivate keys.

**Important notes about API keys:**
- Do not share your API key with anyone
- If you suspect unauthorized usage, regenerate your API key immediately
- All API keys on your account share the same rate limit quota
- Paste API keys carefully — hidden spaces cause authentication failures
- Deactivate old keys you no longer use to avoid quota fragmentation

---

## What is the difference between pay-as-you-go and a Coding Plan?

**Problem description:**
Users are confused about whether they need to purchase a Coding Plan subscription or can simply top up a cash balance to use the GLM API with coding extensions.

**Solution:**
Z.ai offers two API usage modes. You do not need a Coding Plan to use the API.

**Pay-as-you-go (no subscription required):**
- Top up a cash balance in your account
- Use the standard endpoint: `https://api.z.ai/api/paas/v4`
- Charged per request from your cash balance
- No monthly commitment

**Coding Plan subscription (Lite, Pro, or Max):**
- Monthly or annual subscription with a fixed quota
- Must use the dedicated endpoint: `https://api.z.ai/api/coding/paas/v4`
- Requests use subscription quota, not cash balance
- Subject to weekly caps and peak-hour multipliers (3x–5x token consumption during peak hours)

**Critical:** Using the wrong endpoint for your plan type causes error `1113` Insufficient balance. Pay-as-you-go users must use `/api/paas/v4`. Coding Plan users must use `/api/coding/paas/v4`.

---

## Which GLM model should I use?

**Problem description:**
Users with Z.ai Coding Plan subscriptions are unsure which model names to use in their coding extension configuration and receive errors when trying to use models like `sonnet` or other non-GLM model names.

**Solution:**
When using Z.ai's API, you must use GLM model names, not model names from other providers.

**Available models for Coding Plan users:**
- `glm-4.7` — recommended for most coding tasks
- `glm-5` — latest generation, higher capability

**Common mistake:** Configuring your tool to use `claude-sonnet`, `gpt-4`, or other provider model names with Z.ai's API endpoint will fail. Always use `glm-4.7` or `glm-5`.

**Configuration checklist:**
1. Set Base URL to `https://api.z.ai/api/coding/paas/v4` (Coding Plan) or `https://api.z.ai/api/paas/v4` (pay-as-you-go)
2. Set model to `glm-4.7` or `glm-5`
3. Paste API key without spaces
4. Save and restart your tool

---

