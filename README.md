# AP Personal Assistant

A personal organizer that runs itself. One month calendar always on screen, two calendars
(Work / Home) you can toggle or overlay, priority shown by shape and color, a side panel with
the next thing to do, quick add by typing or speaking, an end-of-day "Tomorrow" pencil-in, and
a Claude brain that files and reshuffles within the rules.

Vanilla HTML/CSS/JS PWA on GitHub Pages. Data in Supabase (Row Level Security, owner only).
No build step. Push to `main` and it deploys.

- App: https://adampurdy101.github.io/ap-personal-assistant/
- Technical notes: [AP.md](AP.md) · look spec: [design/LOOK-v2.md](design/LOOK-v2.md)

## Files
- `index.html` — shell
- `css/app.css` — the look (light paper, charcoal hairlines, tan + olive fills)
- `js/app.js` — panel, calendar, quick add, Tomorrow, chip controls, popover
- `js/auth.js` — owner-only email login
- `js/config.js` — public Supabase URL + publishable key (safe by design)
- `sw.js`, `manifest.webmanifest` — installable app
- `supabase/functions/ap-brain`, `supabase/functions/ap-meetings` — edge functions
