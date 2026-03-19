# Subscription Management — Knowledge Base

---

## How do I cancel my Z.ai subscription?

**Problem description:**
Users want to cancel their Coding Plan subscription (Lite, Pro, or Max) and are unsure of the cancellation process or what happens to their remaining quota after cancellation.

**Solution:**
To cancel your Z.ai subscription, go to your account dashboard at https://chat.z.ai and navigate to Billing settings. Find your active subscription and select the cancellation option.

**What happens after cancellation:**
- You retain access to your subscription quota until the end of the current billing period
- No refunds are issued for unused quota or remaining days
- Your account reverts to pay-as-you-go mode after the period ends
- Any cash balance in your account remains available for pay-as-you-go usage

---

## What happens to my quota at the end of the billing period?

**Problem description:**
Users are unsure whether unused quota rolls over to the next billing period or expires at the end of each period.

**Solution:**
Subscription quota does not roll over. Any unused quota from your current billing period expires at the end of that period and does not carry forward to the next month or cycle.

**Quota consumption notes:**
- During peak hours, token consumption is multiplied by 3x–5x
- Weekly caps limit total token usage regardless of your monthly quota
- Referral credits and cash balance are consumed before subscription quota in some scenarios
- Monitor your usage in the developer dashboard to avoid unexpected quota exhaustion

---

## What is the difference between Lite, Pro, and Max Coding Plans?

**Problem description:**
Users are unsure which Coding Plan tier to choose and what the differences are between Lite, Pro, and Max plans.

**Solution:**
Z.ai offers three Coding Plan tiers with different quota allowances and rate limits.

**Key differences:**
- **Lite** — entry level, lowest quota, suitable for light personal use
- **Pro** — mid tier, 100 requests per minute rate limit across all API keys combined
- **Max** — highest quota, suitable for heavy or team use

All tiers are subject to:
- Weekly token caps
- Peak-hour multipliers (3x–5x during high traffic periods)
- Shared rate limits across all API keys on the account

---

## Can I upgrade or downgrade my subscription plan?

**Problem description:**
Users want to change their current Coding Plan tier — either upgrading to a higher tier or downgrading to a lower one — and are unsure of the process or cost implications.

**Solution:**
Plan changes are managed through your account dashboard at https://chat.z.ai under Billing settings.

**Important billing note for upgrades:**
When upgrading and the current plan price has changed since your original purchase, the system charges the price difference immediately. This is not an error — it reflects the updated subscription pricing. The extra charge is legitimate and represents the difference between your old plan price and the new plan price.

**If you see an unexpected charge after changing your plan:**
1. Verify the charge matches the price difference between plan tiers
2. Contact support with your User ID and payment receipt if you believe the charge is incorrect

---

## How do referral credits work?

**Problem description:**
Users who earned referral credits are unsure how those credits are applied to their account and why their balance may decrease unexpectedly.

**Solution:**
Referral credits are treated as account balance and are automatically consumed by API requests. When you make API calls, the system deducts the cost from your available balance including referral credits in real time.

**How referral credits are consumed:**
- Credits are deducted automatically as you make API requests
- Usage may not appear immediately in the billing history interface
- Credits are consumed before cash balance in most scenarios
- There is no separate tracking panel for referral credit usage — check your API usage logs

**To monitor credit usage:**
1. Review API usage logs in the developer dashboard
2. Check which endpoints and models your applications are calling
3. Verify your applications are not making unexpected background API calls
4. If you suspect unauthorized usage, regenerate your API keys immediately

---
