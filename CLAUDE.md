# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Serverless backend for the **Dona'm Bauxa** music event discovery platform in Mallorca. Converts Instagram posts about events into structured JSON by combining Instagram APIs with Google Gemini AI vision analysis.

## Development

```bash
npm install
vercel dev   # local development server
```

There are no test or lint scripts configured.

## Deployment

Push to main branch — Vercel auto-deploys. Functions are defined in `vercel.json` with a 60-second max duration.

## Architecture

Three Vercel serverless functions in `api/`:

### `api/analyze.ts` — Main endpoint (POST)

Four input modes:

| Mode | Body | Caption via |
|---|---|---|
| A-meta | `{ instagramUrl, provider: "meta" }` | Meta oEmbed (imatge del thumbnail) |
| A-apify | `{ instagramUrl, provider: "apify" }` | Apify async → retorna 202, webhook continua |
| B | `{ imageBase64, imageMimeType, instagramUrl }` | Apify síncron (espera resultat) |
| E | `{ imageBase64, imageMimeType, caption }` | Manual |

`imageBase64` és la imatge codificada en base64 (e.g. enganxada del porta-retalls). `imageMimeType` és el tipus MIME (`"image/png"`, `"image/jpeg"`…).

Common processing: image + caption → Gemini 2.5 Flash (Catalan prompt) → publish to Dona'm Bauxa API.

### `api/webhook-apify.ts` — Apify webhook receiver (POST)

Called by Apify when its Instagram scraper actor completes (mode A-apify). Fetches the dataset, extracts the `caption` from the first item (no image), then runs Gemini → Dona'm Bauxa. Always returns 200 to prevent Apify retries.

### `api/generate.tsx` — OG image generator (POST)

Vercel Edge Runtime (uses `@vercel/og`). Accepts the structured event JSON and returns a 1080×1080 PNG with a dark-themed event schedule. CORS restricted to `donambauxa.online`.

## Gemini Output Schema

All three endpoints converge on this shape before publishing:

```json
{
  "date": "DD/MM/YYYY",
  "zones": [
    {
      "name": "Stage or zone name",
      "events": [
        { "name": "Artist name", "time": "HH:MM", "categoryColor": "#RRGGBB" }
      ]
    }
  ]
}
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `META_APP_ID` / `META_CLIENT_TOKEN` | Meta Graph API (oEmbed) |
| `APIFY_TOKEN` | Apify Instagram scraper |
| `GEMINI_API_KEY` | Google Generative AI |
| `DONAMBAUXA_SECRET` | Bearer token for publishing to Dona'm Bauxa API |

Local overrides go in `.env.local` (gitignored). Production values in `.env` (gitignored).
