/**
 * RSMS Lesson AI — Cloudflare Worker
 * Proxies requests to Anthropic Claude API
 * API key stored as Cloudflare Environment Variable (never in code)
 * 
 * Setup: Workers → Settings → Variables and Secrets
 *   → Add Secret → Name: ANTHROPIC_KEY → Value: sk-ant-api03-...
 */

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Check API key is configured
    if (!env.ANTHROPIC_KEY) {
      return new Response(JSON.stringify({
        error: 'ANTHROPIC_KEY not configured. Add it in Cloudflare Worker Settings → Variables and Secrets.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const body = await request.json();

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
  }
};
