import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

const DONAMBAUXA_API = 'https://www.donambauxa.online/api/events/create';

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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { instagramUrl } = req.body as { instagramUrl?: string };

  if (!instagramUrl) {
    res.status(400).json({ error: 'Missing required field: instagramUrl' });
    return;
  }

  try {
    // 1. Fetch post data via Instagram oEmbed (official Meta Graph API)
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

    // 2. Fetch thumbnail image and convert to Base64
    const imageRes = await fetch(thumbnailUrl);
    if (!imageRes.ok) {
      throw new Error(`Image fetch failed: ${imageRes.status}`);
    }

    const imageBuffer = await imageRes.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    const mimeType = imageRes.headers.get('content-type') || 'image/jpeg';

    // 3. Analyze with Gemini 1.5 Flash (multimodal)
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });

    const result = await model.generateContent([
      { inlineData: { data: base64Image, mimeType } },
      `${GEMINI_PROMPT}\n\nCaption de l'Instagram:\n${caption}`,
    ]);

    const structuredData = JSON.parse(result.response.text());

    // 4. POST structured data to donambauxa.online
    const publishRes = await fetch(DONAMBAUXA_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DONAMBAUXA_SECRET}`,
      },
      body: JSON.stringify(structuredData),
    });

    if (!publishRes.ok) {
      const errorText = await publishRes.text();
      throw new Error(`donambauxa API error ${publishRes.status}: ${errorText}`);
    }

    res.status(200).json({ message: 'Event created successfully', data: structuredData });
  } catch (err) {
    console.error('Error processing Instagram post:', err);
    res.status(500).json({
      error: 'Internal server error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
