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
    console.error('Webhook: Missing resource.defaultDatasetId');
    res.status(200).json({ received: true, error: 'Missing datasetId' });
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
      res.status(200).json({ received: true, error: 'No displayUrl found' });
      return;
    }

    const structuredData = await analyzeWithGemini(post.displayUrl, post.caption ?? '');
    await publishToDonambauxa(structuredData);

    res.status(200).json({ received: true, message: 'Event created successfully' });
  } catch (err) {
    // Sempre 200 per evitar reintents d'Apify
    console.error('Webhook error:', err);
    res.status(200).json({ received: true, error: err instanceof Error ? err.message : String(err) });
  }
}
