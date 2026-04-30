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

  // Sempre retornem 200 a Apify per evitar reintents automàtics
  res.status(200).json({ received: true });

  if (!datasetId) {
    console.error('Webhook: Missing resource.defaultDatasetId');
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
      console.error('Webhook: No displayUrl found in dataset');
      return;
    }

    const structuredData = await analyzeWithGemini(post.displayUrl, post.caption ?? '');
    await publishToDonambauxa(structuredData);
    console.log('Webhook: Event created successfully');
  } catch (err) {
    console.error('Webhook error:', err);
  }
}
