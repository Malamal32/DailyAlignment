# DailyAlignment

Astrology mood and energy journal. A Cloudflare Worker serves the app and handles email-code sign-in and sync. Your journal lives in your account, so there's nothing to back up by hand.

## Files
- `public/index.html`: the whole app in one file.
- `src/index.js`: the Worker. It serves `public/` and the `/api/*` routes: email code, verify, sync, sign out.
- `wrangler.jsonc`: Worker config. It holds the D1 database, the email binding and the sender address.
- `schema.sql`: the tables, for reference only. The Worker creates them automatically.

## One-time setup

### 1. Database (free)
1. In the Cloudflare dashboard, go to **Storage & databases → D1 SQL database → Create** and name it `dailyalignment`.
2. Copy the **Database ID** into `wrangler.jsonc` in place of `PASTE-YOUR-DATABASE-ID-HERE`.

If you already created it, paste the same ID again.

### 2. Email for sign-in codes
You need a domain on Cloudflare. To keep this app fully separate from anything else on that domain, send from a subdomain such as `mail.yourdomain.com`.

1. In the dashboard, go to **Compute → Email Service → Email Sending → Onboard Domain** and choose the subdomain. Cloudflare adds DNS records for that subdomain only.
2. In `wrangler.jsonc`, set `MAIL_FROM` to an address on it, such as `login@mail.yourdomain.com`.
3. **Free plan:** Cloudflare can only send to addresses you've verified. Add your own email under **Email Routing → Destination addresses** and click the link Cloudflare emails you. That's enough when you're the only person signing in.
4. **To let anyone sign in**, either upgrade to Workers Paid or use Resend's free tier. For Resend, verify your domain there, run `npx wrangler secret put RESEND_API_KEY` (or add it under Settings → Variables and secrets), and remove the `send_email` block from `wrangler.jsonc`. The Worker uses Resend whenever the Cloudflare binding isn't present.

Cloudflare's email sending is still in beta, so menu names may differ slightly.

### 3. Push
```
git add .
git commit -m "Email code sign-in"
git push
```
Cloudflare redeploys from GitHub. Your link is under your Worker's **Settings → Domains & Routes**.

## Signing in
Open **Me → Account**, enter your email and tap **Email me a code**. Then type the 6-digit code; the app signs in as soon as all six digits are in. Use the same email on your phone and your computer.

- Codes expire after 10 minutes and allow 5 tries.
- You stay signed in for a year on each device.
- Entries already on a device are merged into your account the first time you sign in there.
- Changes sync within a couple of seconds. While the app is open it also checks every minute and whenever you come back to it.
- Offline, entries save on the device and sync later. If the same day is edited on two devices while both are offline, the most recent edit wins.

## Install on a phone
- **iPhone:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome, then tap Install app.

When you deploy a new `index.html`, change `VERSION` in `public/sw.js` so phones update.

## Notes
- Me → Your data → Download a copy is optional; your account already holds everything.
- Me → Erase my journal clears every device signed in to your account.
- Planet positions are calculated in the browser (Astronomy Engine). Place search uses Open-Meteo. Neither needs a key.
