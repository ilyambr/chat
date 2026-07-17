export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Check if the request is for our proxy
    if (url.pathname === '/bams/chat/api-proxy' || url.pathname === '/bams/chat/api-proxy/') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response('Missing url parameter', {
          status: 400,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/plain'
          }
        });
      }

      // Handle CORS preflight options request
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400'
          }
        });
      }

      // Prepare headers for the target request
      const initHeaders = new Headers();
      initHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      initHeaders.set('Referer', 'https://www.youtube.com');

      // Forward specific headers if present
      const headersToForward = [
        'content-type',
        'x-youtube-client-name',
        'x-youtube-client-version',
        'x-goog-visitor-id'
      ];
      for (const h of headersToForward) {
        if (request.headers.has(h)) {
          initHeaders.set(h, request.headers.get(h));
        }
      }

      const init = {
        method: request.method,
        headers: initHeaders
      };

      if (request.method === 'POST') {
        init.body = await request.text();
      }

      try {
        const response = await fetch(targetUrl, init);
        
        // Construct clean response headers
        const responseHeaders = new Headers();
        
        // Copy headers from response except restricted headers
        const headersToCopy = [
          'content-type',
          'content-encoding',
          'cache-control'
        ];
        for (const h of headersToCopy) {
          if (response.headers.has(h)) {
            responseHeaders.set(h, response.headers.get(h));
          }
        }

        // Set permissive CORS headers
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', '*');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      } catch (err) {
        return new Response('Proxy request failed: ' + err.message, {
          status: 500,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/plain'
          }
        });
      }
    }

    // Serve static assets for all other routes
    return env.ASSETS.fetch(request);
  }
};
