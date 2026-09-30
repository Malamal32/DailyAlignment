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

## Notes
- Planet positions are calculated in the browser using the Astronomy Engine library, loaded from jsDelivr. Place search uses Open-Meteo. Neither needs an API key.
- Entries and settings aren't saved yet, so a reload resets them.
