const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 7891;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // Download proxy — fetches remote video server-side to avoid CORS issues
  if (req.url.startsWith('/download?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const videoUrl = params.get('url');
    const filename = params.get('filename') || 'video.mp4';
    if (!videoUrl) { res.writeHead(400, cors); res.end('Missing url'); return; }

    const parsed = new URL(videoUrl);
    const options = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET' };
    const proto = parsed.protocol === 'https:' ? https : http;
    const proxy = proto.request(options, upstream => {
      res.writeHead(200, {
        ...cors,
        'Content-Type': upstream.headers['content-type'] || 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': upstream.headers['content-length'] || '',
      });
      upstream.pipe(res);
    });
    proxy.on('error', err => { res.writeHead(500, cors); res.end(err.message); });
    proxy.end();
    return;
  }

  // Vary-prompts — calls Anthropic Claude to generate N prompt variations
  if (req.url === '/vary-prompts' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) { res.writeHead(400, cors); res.end('Bad JSON'); return; }
      const { prompt, count = 3, anthropicKey } = parsed;
      if (!prompt || !anthropicKey) { res.writeHead(400, cors); res.end('Missing prompt or anthropicKey'); return; }

      const systemPrompt = `You are a video prompt rewriter specializing in character and scene variations. Given a base prompt, rewrite it ${count} times. Each variation must keep the SAME subject type and action from the original, but change the following to make each video look visually distinct:
- Clothing style and color (e.g. casual, formal, sporty, traditional, colorful, monochrome)
- Hair (color, length, style)
- Background / setting (e.g. park, kitchen, street, beach, office, forest)
- Lighting and time of day (e.g. bright morning, warm sunset, dim indoor, overcast)
- Mood or expression if relevant

Do NOT change the core subject type or main action. Make each variation clearly different from the others.
Return ONLY a valid JSON array of ${count} strings. No explanation, no markdown.`;
      const userMsg = `Base prompt: "${prompt}"\n\nGenerate ${count} visually distinct variations:`;
      const payload = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
      };

      const proxy = https.request(options, upstream => {
        let data = '';
        upstream.on('data', d => data += d);
        upstream.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.error) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: result.error.message })); return; }
            const text = result.content[0].text.trim();
            // Extract JSON array from response
            const match = text.match(/\[[\s\S]*\]/);
            const prompts = match ? JSON.parse(match[0]) : [prompt];
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ prompts }));
          } catch(e) {
            res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Parse error: ' + e.message }));
          }
        });
      });
      proxy.on('error', err => { res.writeHead(500, cors); res.end(JSON.stringify({ error: err.message })); });
      proxy.write(payload);
      proxy.end();
    });
    return;
  }

  // Proxy all /api/* calls to Replicate
  if (req.url.startsWith('/api/')) {
    const replicatePath = req.url.replace('/api', '/v1');
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const options = {
        hostname: 'api.replicate.com',
        path: replicatePath,
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers['authorization'] || '',
        },
      };

      const proxy = https.request(options, upstream => {
        let data = '';
        upstream.on('data', d => data += d);
        upstream.on('end', () => {
          res.writeHead(upstream.statusCode, { ...cors, 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      proxy.on('error', err => {
        res.writeHead(500, cors);
        res.end(JSON.stringify({ detail: err.message }));
      });

      if (body) proxy.write(body);
      proxy.end();
    });
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { ...cors, 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
