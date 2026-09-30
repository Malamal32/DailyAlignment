# DailyAlignment

Astrology mood and energy journal, served as a static site from a Cloudflare Worker.

## Files
- `public/index.html`: the whole app in one file (content database included).
- `wrangler.jsonc`: Worker config that serves `public/` as static assets. There's no Worker script.

## Put it on GitHub
```
git init
git add .
git commit -m "DailyAlignment prototype"
git branch -M main
git remote add origin https://github.com/<you>/daily-alignment.git
git push -u origin main
```

## Deploy to Cloudflare Workers
Option A, from your computer:
```
npx wrangler login
npx wrangler deploy
```

Option B, from GitHub. In the Cloudflare dashboard go to Workers & Pages, then Create, then Import a repository, and pick this repo. Leave the build command empty and set the deploy command to `npx wrangler deploy`. After that, every push to `main` redeploys.

## Install on a phone
The site works as an installable app.
- **iPhone:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome, then tap Install app (or ⋮ → Add to Home screen).

Once installed, it opens full-screen, works offline after the first visit, and keeps your journal on the device. When you deploy a new `index.html`, change `VERSION` in `public/sw.js` so phones pick up the update.

## Notes
- Planet positions are calculated in the browser using the Astronomy Engine library, loaded from jsDelivr. Place search uses Open-Meteo. Neither needs an API key.
- Check-ins, entries, settings and season reviews are saved in the browser's local storage on each device. Me → Erase my journal clears them. Clearing the browser's site data also deletes them.
