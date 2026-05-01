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

interface ImageInline {
  data: string;
  mimeType: string;
}

export async function analyzeWithGemini(
  imageUrl: string | null,
  caption: string,
  imageInline?: ImageInline
) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const parts: Parameters<typeof model.generateContent>[0] = [];

  if (imageInline) {
    parts.push({ inlineData: { data: imageInline.data, mimeType: imageInline.mimeType } });
  } else if (imageUrl) {
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

async function fetchCaptionApify(instagramUrl: string): Promise<string> {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const run = await client.actor('apify/instagram-scraper').call({
    directUrls: [instagramUrl],
    resultsType: 'posts',
    resultsLimit: 1,
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return (items[0] as { caption?: string })?.caption ?? '';
}

async function fetchOembed(instagramUrl: string): Promise<OEmbedResponse> {
  const accessToken = `${process.env.META_APP_ID}|${process.env.META_CLIENT_TOKEN}`;
  const oembedRes = await fetch(
    `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(instagramUrl)}&access_token=${accessToken}`
  );
  if (!oembedRes.ok) {
    const errBody = (await oembedRes.json()) as OEmbedResponse;
    throw new Error(`oEmbed API error ${oembedRes.status}: ${errBody.error?.message ?? 'unknown'}`);
  }
  return oembedRes.json() as Promise<OEmbedResponse>;
}

async function analyzeMeta(instagramUrl: string): Promise<unknown> {
  const oembed = await fetchOembed(instagramUrl);
  const caption = oembed.title ?? '';
  const thumbnailUrl = oembed.thumbnail_url;
  if (!thumbnailUrl) throw new Error('No image found for this post');
  return analyzeWithGemini(thumbnailUrl, caption);
}

async function analyzeImageBase64WithApify(
  imageBase64: string,
  imageMimeType: string,
  instagramUrl: string
): Promise<unknown> {
  const caption = await fetchCaptionApify(instagramUrl);
  return analyzeWithGemini(null, caption, { data: imageBase64, mimeType: imageMimeType });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { instagramUrl, provider, imageBase64, imageMimeType, caption, dryRun } = req.body as {
    instagramUrl?: string;
    provider?: 'meta' | 'apify';
    imageBase64?: string;
    imageMimeType?: string;
    caption?: string;
    dryRun?: boolean;
  };

  const respond = async (structuredData: unknown) => {
    if (!dryRun) await publishToDonambauxa(structuredData);
    res.status(200).json({ dryRun: !!dryRun, data: structuredData });
  };

  try {
    // Mode A: Instagram URL amb provider (meta o apify async)
    if (instagramUrl && !imageBase64) {
      if (!provider || (provider !== 'meta' && provider !== 'apify')) {
        res.status(400).json({ error: 'Field "provider" must be "meta" or "apify" when instagramUrl is provided' });
        return;
      }
      if (provider === 'apify') {
        const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
        const run = await client.actor('apify/instagram-scraper').start(
          { directUrls: [instagramUrl], resultsType: 'posts', resultsLimit: 1 },
          { webhooks: [{ eventTypes: ['ACTOR.RUN.SUCCEEDED'], requestUrl: WEBHOOK_URL }] }
        );
        res.status(202).json({ message: 'Scraping initiated', runId: run.id });
      } else {
        await respond(await analyzeMeta(instagramUrl));
      }
      return;
    }

    // Mode B: imageBase64 + instagramUrl (caption via Apify síncron)
    if (imageBase64 && instagramUrl) {
      if (!imageMimeType) {
        res.status(400).json({ error: 'Field "imageMimeType" is required with imageBase64' });
        return;
      }
      await respond(await analyzeImageBase64WithApify(imageBase64, imageMimeType, instagramUrl));
      return;
    }

    // Mode E: imageBase64 + caption manual
    if (imageBase64 && caption !== undefined) {
      if (!imageMimeType) {
        res.status(400).json({ error: 'Field "imageMimeType" is required with imageBase64' });
        return;
      }
      await respond(await analyzeWithGemini(null, caption, { data: imageBase64, mimeType: imageMimeType }));
      return;
    }

    res.status(400).json({
      error: 'Send one of: { instagramUrl, provider } | { imageBase64, imageMimeType, instagramUrl } | { imageBase64, imageMimeType, caption }',
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({
      error: 'Internal server error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
