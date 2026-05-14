/**
 * RSMS Cloudflare Worker
 * Routes *.rsms.rehoteq.com -> rsms.rehoteq.com (same GitHub Pages)
 * while preserving the original subdomain in a header
 * so rsms-login.html can detect which school to load
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname; // e.g. adetola.rsms.rehoteq.com

    // Pass subdomain as cookie so the login page can read it
    const parts = host.split('.');
    const subdomain = parts.length >= 4 ? parts[0] : '';

    // Rewrite to main GitHub Pages domain
    const newUrl = new URL(url.toString());
    newUrl.hostname = 'rsms.rehoteq.com';

    // Fetch from GitHub Pages
    const newRequest = new Request(newUrl.toString(), {
      method:  request.method,
      headers: request.headers,
      body:    request.method !== 'GET' && request.method !== 'HEAD'
               ? request.body : undefined,
    });

    const response = await fetch(newRequest);

    // Clone response and inject subdomain cookie
    const newResponse = new Response(response.body, response);
    newResponse.headers.set(
      'Set-Cookie',
      'rsms_subdomain=' + subdomain + '; Path=/; SameSite=Lax'
    );
    // Allow CORS
    newResponse.headers.set('Access-Control-Allow-Origin', '*');

    return newResponse;
  }
};
