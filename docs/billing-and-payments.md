# Billing and Payments — Knowledge Base

---

## Why was I charged extra when I enabled auto-renewal for my subscription?

**Problem description:**
Users who enabled auto-renewal for their subscription were charged an additional amount (e.g., $316.93 USD on top of a $370 max plan purchase) without the expected extension of their subscription period. The charge appeared immediately after turning on auto-renewal, but the subscription duration did not change accordingly.

**Solution:**
When you enable auto-renewal and the current subscription plan price has increased since your original purchase, the system charges the price difference to upgrade your subscription to the current pricing. This happens because the new subscription plan is more expensive than the previous pricing tier.

**What the charge represents:**
- The extra charge is the difference between your old plan price and the new plan price
- This occurs when auto-upgrading to the current pricing structure
- The charge is legitimate and reflects the updated subscription cost

**If you believe this is an error:**
1. Contact support with your User ID and payment receipt
2. Provide screenshots of the charge and your subscription details
3. Support will escalate to the tech team for review

---

## Why did my referral credit balance disappear from my account?

**Problem description:**
Users with accumulated referral reward credits (e.g., $52 from referral program) found their balance showing as $0 with no transaction history, no email notification, and no explanation. The credits disappeared without any visible usage or deduction records in the billing history.

**Solution:**
Referral credits are consumed by API requests. When you use the Z.ai API, the system automatically deducts the cost from your available balance, including referral credits. The usage may not always be immediately visible in the billing history interface.

**How referral credits work:**
- Referral credits are treated as account balance
- API requests automatically consume credits before charging cash
- The deduction happens in real-time as you make API calls
- Check your API usage logs to see where credits were consumed

**To track credit usage:**
1. Review your API usage logs in the developer dashboard
2. Check which endpoints and models you're calling
3. Verify your applications are not making unexpected API calls
4. Monitor your API key usage for any unauthorized access

---
