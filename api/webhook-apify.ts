import type { VercelRequest, VercelResponse } from '@vercel/node';
import { analyzeWithGemini, publishToDonambauxa } from './analyze.js';

interface ApifyItem {
  displayUrl?: string;
  caption?: string;
}

interface ApifyWebhookPayload {
  resource?: {
    defaultDatasetId?: string;
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const payload = req.body as ApifyWebhookPayload;
  const datasetId = payload?.resource?.defaultDatasetId;

  if (!datasetId) {
    res.status(400).json({ error: 'Missing resource.defaultDatasetId in webhook payload' });
    return;
  }

  try {
    const datasetRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_TOKEN}`
    );
    if (!datasetRes.ok) throw new Error(`Apify dataset fetch failed: ${datasetRes.status}`);

    const items = (await datasetRes.json()) as ApifyItem[];
    const post = items[0];

    if (!post?.displayUrl) {
      res.status(400).json({ error: 'No displayUrl found in dataset' });
      return;
    }

    const structuredData = await analyzeWithGemini(post.displayUrl, post.caption ?? '');
    await publishToDonambauxa(structuredData);

    res.status(200).json({ message: 'Event created successfully', data: structuredData });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({
      error: 'Internal server error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
