import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ApifyClient } from 'apify-client';
import { ProxyAgent, fetch as proxyFetch } from 'undici';

const DONAMBAUXA_API = 'https://www.donambauxa.online/api/events/create';
const WEBHOOK_URL = 'https://post-to-json-api.vercel.app/api/webhook-apify';

const GEMINI_PROMPT = `Analitza aquesta imatge i el text del caption d'Instagram d'un esdeveniment de música a Mallorca.
Extreu la programació musical i retorna ÚNICAMENT un objecte JSON vàlid amb aquesta estructura exacta, sense cap text addicional:
{
  "date": "DD/MM/YYYY",
  "zones": [
    {
      "name": "Nom de la zona o escenari",
      "events": [
        {
          "name": "Nom de l'artista o activitat",
          "time": "HH:MM",
          "categoryColor": "#RRGGBB"
        }
      ]
    }
  ]
}

Assigna colors de categoria de manera consistent: música electrònica → #8B5CF6, reggaeton/urbà → #EC4899, live music → #F59E0B, altres → #6B7280.
Si no trobes informació clara per algun camp, usa valors per defecte raonables.`;

interface OEmbedResponse {
  title?: string;
  thumbnail_url?: string;
  error?: { message: string; code: number };
}

export async function analyzeWithGemini(imageUrl: string | null, caption: string) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const parts: Parameters<typeof model.generateContent>[0] = [];

  if (imageUrl) {
    try {
      const proxyUrl = `http://auto:${process.env.APIFY_TOKEN}@proxy.apify.com:8000`;
      const agent = new ProxyAgent(proxyUrl);
      const imageRes = await proxyFetch(imageUrl, { dispatcher: agent });
      if (imageRes.ok) {
        const imageBuffer = await imageRes.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const mimeType = imageRes.headers.get('content-type') || 'image/jpeg';
        parts.push({ inlineData: { data: base64Image, mimeType } });
      }
    } catch {
      console.warn('Image fetch via proxy failed, falling back to text-only analysis');
    }
  }

  parts.push(`${GEMINI_PROMPT}\n\nCaption de l'Instagram:\n${caption}`);

  const result = await model.generateContent(parts);
  return JSON.parse(result.response.text());
}

export async function publishToDonambauxa(data: unknown) {
  const res = await fetch(DONAMBAUXA_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DONAMBAUXA_SECRET}`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`donambauxa API error ${res.status}: ${text}`);
  }
}

async function handleMeta(instagramUrl: string, res: VercelResponse) {
  const accessToken = `${process.env.META_APP_ID}|${process.env.META_CLIENT_TOKEN}`;
  const oembedRes = await fetch(
    `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(instagramUrl)}&access_token=${accessToken}`
  );

  if (!oembedRes.ok) {
    const errBody = (await oembedRes.json()) as OEmbedResponse;
    throw new Error(`oEmbed API error ${oembedRes.status}: ${errBody.error?.message ?? 'unknown'}`);
  }

  const oembed = (await oembedRes.json()) as OEmbedResponse;
  const caption = oembed.title ?? '';
  const thumbnailUrl = oembed.thumbnail_url;

  if (!thumbnailUrl) {
    res.status(400).json({ error: 'No image found for this post' });
    return;
  }

  const structuredData = await analyzeWithGemini(thumbnailUrl, caption);
  await publishToDonambauxa(structuredData);
  res.status(200).json({ message: 'Event created successfully', data: structuredData });
}

async function handleApify(instagramUrl: string, res: VercelResponse) {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const run = await client.actor('apify/instagram-scraper').start(
    { directUrls: [instagramUrl], resultsType: 'posts', resultsLimit: 1 },
    { webhooks: [{ eventTypes: ['ACTOR.RUN.SUCCEEDED'], requestUrl: WEBHOOK_URL }] }
  );
  res.status(202).json({ message: 'Scraping initiated', runId: run.id });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { instagramUrl, provider, imageUrl, caption } = req.body as {
    instagramUrl?: string;
    provider?: 'meta' | 'apify';
    imageUrl?: string;
    caption?: string;
  };

  try {
    // Mode A: Instagram URL amb provider
    if (instagramUrl) {
      if (!provider || (provider !== 'meta' && provider !== 'apify')) {
        res.status(400).json({ error: 'Field "provider" must be "meta" or "apify" when instagramUrl is provided' });
        return;
      }
      if (provider === 'meta') await handleMeta(instagramUrl, res);
      else await handleApify(instagramUrl, res);
      return;
    }

    // Mode B: imageUrl + caption manual
    if (imageUrl && caption !== undefined) {
      const structuredData = await analyzeWithGemini(imageUrl, caption);
      await publishToDonambauxa(structuredData);
      res.status(200).json({ message: 'Event created successfully', data: structuredData });
      return;
    }

    res.status(400).json({
      error: 'Send { instagramUrl, provider } or { imageUrl, caption }',
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({
      error: 'Internal server error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
