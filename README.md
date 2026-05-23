# calorie-bot

A Telegram bot that uses Claude's vision API to analyze food photos, estimate macros, and log meals to Google Sheets and a local SQLite database.

## Features

- Send a food photo → Claude estimates calories, protein, carbs, fat, fiber
- Confirm or edit the estimate, then log it
- Daily totals with progress bars via `/today`
- Optional Google Sheets sync for persistent logging and dashboards
- Targets fetched live from a Settings sheet

## Stack

- [Bun](https://bun.com) — runtime, SQLite, package manager
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — Claude vision for food analysis
- Telegram Bot API (long-polling, no webhook server needed)
- Google Apps Script — Sheets webhook (optional)

## Setup

### 1. Prerequisites

- [Bun](https://bun.com/docs/installation) v1.3+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An [Anthropic API key](https://console.anthropic.com)

### 2. Install dependencies

```bash
bun install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude vision |
| `SHEETS_WEBHOOK` | No | Google Apps Script URL for Sheets logging |
| `TARGET_CALORIES` | No | Daily calorie target (default: 2000) |
| `TARGET_PROTEIN` | No | Daily protein target in grams (default: 150) |
| `TARGET_CARBS` | No | Daily carbs target in grams (default: 200) |
| `TARGET_FAT` | No | Daily fat target in grams (default: 65) |
| `TARGET_FIBER` | No | Daily fiber target in grams (default: 25) |

### 4. Run

```bash
bun run start
```

For development with hot reload:

```bash
bun run dev
```

## Bot Commands

| Command | Description |
|---|---|
| Send a photo | Analyze food and prompt to log |
| `/today` or `/t` | Show today's macro totals |
| `/targets` | Show daily targets |
| `/set calories 1800` | Update a target (calories/protein/carbs/fat) |
| `/help` | Show help |

After sending a photo, tap **Log it** to save, **Edit** to correct values, or **Skip** to discard.

To edit a pending estimate, reply with text like:
- `calories 450`
- `protein 35g`
- `all: 500 cal, 40p, 30c, 15f`

## Google Sheets Integration (optional)

The `sheets-webhook.gs` file contains the Google Apps Script to deploy as a web app:

1. Open your Google Sheet
2. Go to **Extensions → Apps Script**
3. Paste the contents of `sheets-webhook.gs`
4. Click **Deploy → New Deployment → Web App**
5. Set **Execute as: Me** and **Who has access: Anyone**
6. Copy the URL and set it as `SHEETS_WEBHOOK` in your `.env`

The script expects two sheets:
- **Calorie & Macro Tracker** — individual meal log (auto-created)
- **Daily calorie** — daily totals (auto-created)
- **Settings** — optional targets sheet with columns: `KCal`, `protein_g`, `carb_g`, `fat_g`, `fiber_g`

## Project Structure

```
calorie-bot/
├── bot.ts              # Main bot logic (Telegram polling, Claude vision, DB)
├── sheets-webhook.gs   # Google Apps Script for Sheets integration
├── package.json
├── tsconfig.json
├── bun.lock
├── .env.example        # Environment variable template
└── .gitignore
```

## Data Storage

Meals are stored locally in `log.db` (SQLite via `bun:sqlite`). If `SHEETS_WEBHOOK` is set, each logged meal is also synced to Google Sheets asynchronously.
