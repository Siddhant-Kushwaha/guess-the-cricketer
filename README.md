# Guess the Cricketer 🏏

**Play it now → [siddhant-kushwaha.github.io/guess-the-cricketer](https://siddhant-kushwaha.github.io/guess-the-cricketer/)**

A free daily cricket guessing game. One mystery cricketer a day — crack it in 8 guesses from attribute feedback, keep your streak alive, and share a spoiler-free emoji grid with your friends. If you've been looking for a *Wordle for cricket* — a daily cricket puzzle you can play with your friends on WhatsApp — this is it.

No login. No download. No ads between you and the game. Works on any phone browser.

## How to play

1. Type any cricketer's name — an autocomplete suggests players from the pool.
2. Each guess lights up seven attribute tiles:

   | Tile | Meaning |
   |---|---|
   | 🟩 Exact | This attribute matches the mystery player |
   | 🟨 Close | Nearly right — same region, related role, same bowling family, or a number within 3 |
   | ⬛ Wrong | Not this one |
   | ▲ / ▼ | For debut year and shirt number: the answer is higher / lower |
   | ⬜ dashed ? | No recorded shirt number to compare — neutral, not wrong |

3. **"Close" decoded:** Roles are Batter, Bowler, Allrounder, Keeper — a yellow role tile means a *related* role (Keeper ↔ Batter; Allrounder ↔ any specialist). Yellow country = same region (e.g. subcontinent). Yellow bowling = same family (pace ↔ pace, spin ↔ spin).
4. Solve it and share your emoji grid — it never spoils the answer.

## Modes

- **🏆 IPL Mode** (default) — the mystery player has played in the IPL. Recognisable names, easier ride.
- **🎓 Legend Mode** — the full cross-era pool, from Bradman to Bumrah. For the stats nerds.
- **∞ Unlimited** — practice with random players as many times as you like. Never touches your daily streak.

A new puzzle drops every midnight IST. Yesterday's answer is always shown on the page.

## Features

- **354-player database** across every major cricketing nation and era, hand-verified facts: country, role, batting hand, bowling style, international debut year, main IPL franchise, and shirt number.
- **Daily determinism** — everyone in the world gets the same mystery player each day (seeded by IST date), with independent daily answers for IPL and Legend modes.
- **Streaks & stats** stored on your device (localStorage) — played, win %, streak, max streak, guess distribution.
- **Spoiler-free sharing** via the Web Share API with WhatsApp and clipboard fallbacks.
- **Fast and offline-friendly** — a static site with zero runtime dependencies, zero network calls, and no tracking pixels in the game loop.
- Light & dark themes, keyboard and touch friendly, safe-area aware for notched phones.

## Tech

Plain HTML + CSS + vanilla JavaScript (ES2018). No frameworks, no build step, no backend.

```
index.html    page, SEO metadata, help & FAQ content
styles.css    "Pavilion Almanac" visual identity, light/dark themes
game.js       game engine: daily seeding, feedback logic, streaks, share, autocomplete
data.js       the player database (facts only — no images, no scraped content)
```

### Run locally

```bash
git clone https://github.com/Siddhant-Kushwaha/guess-the-cricketer.git
cd guess-the-cricketer
python3 -m http.server 8000
# open http://localhost:8000
```

### Data corrections

Spotted a wrong debut year, shirt number, or a missing player? Open an issue with a source link — corrections are very welcome. Player facts are kept rights-safe by design: public factual data only, no photographs, no scraped databases.

## Roadmap

- Challenge-a-friend duel links (same mystery player, beat my guess count)
- Fuzzy name matching for misspellings
- Answer archive pages & global "how hard was today" stats
- Hindi interface

---

Made in India, for cricket fans everywhere. All rights reserved.
