import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ApifyClient } from 'apify-client';
import { ProxyAgent, fetch as proxyFetch } from 'undici';

const DONAMBAUXA_API = 'https://www.donambauxa.online/api/requests';
const WEBHOOK_URL = 'https://post-to-json-api.vercel.app/api/webhook-apify';

const CURRENT_YEAR = new Date().getFullYear();

const GEMINI_PROMPT = `Analitza aquesta imatge i el text del caption d'Instagram d'un esdeveniment de música a Mallorca.
Extreu la programació musical i retorna ÚNICAMENT un objecte JSON vàlid seguint l'esquema schema.org, sense cap text addicional:

{
  "@context": "https://schema.org",
  "@type": "EventSeries",
  "name": "Nom de la nit (ex: Divendres 1 Maig)",
  "startDate": "YYYY-MM-DD",
  "location": { "@type": "Place", "name": "Mallorca" },
  "subEvent": [
    {
      "@type": "MusicEvent",
      "name": "Nom de l'artista o nom de la festa",
      "startDate": "YYYY-MM-DDTHH:MM:00+02:00",
      "location": {
        "@type": "MusicVenue",
        "name": "Nom del local",
        "address": {
          "@type": "PostalAddress",
          "addressLocality": "Localitat",
          "addressRegion": "Zona (ex: RAIGUER, LLEVANT, MIGJORN, ES PLA)"
        }
      },
      "additionalProperty": {
        "@type": "PropertyValue",
        "name": "categoryColor",
        "value": "#RRGGBB"
      }
    }
  ]
}

Regles:
- Any: ${CURRENT_YEAR} si la imatge no l'especifica.
- Colors de categoria: electrònica → #8B5CF6, reggaeton/urbà → #EC4899, live music → #F59E0B, altres → #6B7280.
- El camp "name" de cada subEvent és el nom de l'artista o la festa, NO el local.
- El local va a location.name i la localitat a addressLocality.`;

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

const COLOR_TO_CATEGORY: Record<string, string> = {
  '#8B5CF6': 'electronica',
  '#EC4899': 'reggaeton',
  '#F59E0B': 'concert',
  '#6B7280': 'concert',
};

interface SubEvent {
  '@type': string;
  name: string;
  startDate: string;
  location?: {
    name?: string;
    address?: {
      addressLocality?: string;
      addressRegion?: string;
    };
  };
  additionalProperty?: {
    name: string;
    value: string;
  };
}

interface EventSeries {
  '@type': string;
  subEvent?: SubEvent[];
}

function toMusicEvent(sub: SubEvent): object {
  const locality = sub.location?.address?.addressLocality ?? '';
  const venue = sub.location?.name ?? '';
  const zone = sub.location?.address?.addressRegion ?? '';
  const color = sub.additionalProperty?.value ?? '#6B7280';
  const category = COLOR_TO_CATEGORY[color] ?? 'concert';
  const locationName = venue ? `${venue}, ${locality}` : locality;

  return {
    '@type': 'MusicEvent',
    name: sub.name,
    zone,
    category,
    startDate: sub.startDate,
    location: { '@type': 'Place', name: locationName },
    description: `${sub.name} a ${locationName}`,
  };
}

async function postOneEvent(event: object): Promise<void> {
  const res = await fetch(DONAMBAUXA_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.DONAMBAUXA_SECRET!,
    },
    body: JSON.stringify({
      entityType: 'event',
      action: 'create',
      description: 'Nou esdeveniment afegit via bot Instagram',
      proposedData: event,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`donambauxa API error ${res.status}: ${text}`);
  }
}

export async function publishToDonambauxa(data: unknown): Promise<void> {
  const series = data as EventSeries;

  if (series['@type'] === 'EventSeries' && Array.isArray(series.subEvent)) {
    await Promise.all(series.subEvent.map(sub => postOneEvent(toMusicEvent(sub))));
  } else {
    await postOneEvent(data as object);
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
