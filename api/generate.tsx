import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const ALLOWED_ORIGIN = 'https://www.donambauxa.online';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface SchemaAddress {
  addressLocality?: string;
  addressRegion?: string;
}

interface SchemaLocation {
  name?: string;
  address?: SchemaAddress;
}

interface SchemaProperty {
  name: string;
  value: string;
}

interface SubEvent {
  name: string;
  startDate: string;
  location?: SchemaLocation;
  additionalProperty?: SchemaProperty;
}

interface EventSeries {
  name?: string;
  startDate?: string;
  subEvent?: SubEvent[];
}

interface Zone {
  name: string;
  events: { name: string; venue: string; time: string; color: string }[];
}

function parsePayload(payload: EventSeries): { title: string; zones: Zone[] } {
  const title = payload.name ?? payload.startDate ?? '';

  const zoneMap = new Map<string, Zone>();
  for (const sub of payload.subEvent ?? []) {
    const region = sub.location?.address?.addressRegion ?? 'Altres';
    const venue = sub.location?.name ?? sub.location?.address?.addressLocality ?? '';
    const time = sub.startDate ? sub.startDate.substring(11, 16) : '';
    const color = sub.additionalProperty?.value ?? '#6B7280';

    if (!zoneMap.has(region)) zoneMap.set(region, { name: region, events: [] });
    zoneMap.get(region)!.events.push({ name: sub.name, venue, time, color });
  }

  return { title, zones: Array.from(zoneMap.values()) };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let payload: EventSeries;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!payload.subEvent) {
    return new Response(JSON.stringify({ error: 'Missing required field: subEvent' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { title, zones } = parsePayload(payload);

  try {
    const image = new ImageResponse(
      (
        <div
          style={{
            width: '1080px',
            height: '1080px',
            background: 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #0f0f1a 100%)',
            display: 'flex',
            flexDirection: 'column',
            padding: '60px',
            fontFamily: 'sans-serif',
            color: '#ffffff',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: '48px',
            }}
          >
            <div style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '6px', color: '#a78bfa', textTransform: 'uppercase', marginBottom: '12px' }}>
              DONA&apos;M BAUXA
            </div>
            <div style={{ fontSize: '52px', fontWeight: 800, color: '#ffffff', letterSpacing: '2px' }}>
              {title}
            </div>
            <div style={{ width: '120px', height: '3px', background: 'linear-gradient(90deg, #a78bfa, #ec4899)', marginTop: '20px', borderRadius: '2px' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', gap: '32px', flex: 1, flexWrap: 'wrap' }}>
            {zones.map((zone, zoneIdx) => (
              <div
                key={zoneIdx}
                style={{
                  flex: 1,
                  minWidth: '280px',
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: '20px',
                  padding: '32px',
                  border: '1px solid rgba(167,139,250,0.2)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{ fontSize: '22px', fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '3px', marginBottom: '24px', paddingBottom: '16px', borderBottom: '1px solid rgba(167,139,250,0.3)' }}>
                  {zone.name}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {zone.events.map((event, evtIdx) => (
                    <div key={evtIdx} style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                      <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: event.color, flexShrink: 0, boxShadow: `0 0 8px ${event.color}` }} />
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <div style={{ fontSize: '15px', fontWeight: 600, color: '#f3f4f6' }}>{event.name}</div>
                        {event.venue && <div style={{ fontSize: '12px', color: '#6b7280' }}>{event.venue}</div>}
                      </div>
                      <div style={{ fontSize: '15px', color: '#9ca3af', fontWeight: 500, flexShrink: 0 }}>{event.time}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '40px', fontSize: '14px', color: '#6b7280', letterSpacing: '2px' }}>
            donambauxa.online
          </div>
        </div>
      ),
      { width: 1080, height: 1080 }
    );

    const responseHeaders = new Headers(image.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => responseHeaders.set(k, v));
    return new Response(image.body, { status: 200, headers: responseHeaders });
  } catch (err) {
    console.error('Error generating image:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
