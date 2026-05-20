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

  // Describe images via Claude Vision
  if (req.url === '/describe-images' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) { res.writeHead(400, cors); res.end('Bad JSON'); return; }
      const { images, anthropicKey } = parsed;
      if (!images || !images.length || !anthropicKey) { res.writeHead(400, cors); res.end('Missing images or anthropicKey'); return; }

      const content = [
        ...images.map(img => {
          const mediaType = img.split(';')[0].split(':')[1] || 'image/jpeg';
          const data = img.split(',')[1] || img;
          return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
        }),
        {
          type: 'text',
          text: images.length === 1
            ? 'Describe this image in detail for use as a video generation reference. Cover: main subjects, their appearance and position, setting/environment, lighting quality and direction, color palette, mood, texture, and any notable visual elements. Be thorough but concise (3-5 sentences).'
            : `Describe each of these ${images.length} images separately for video generation reference. For each cover: main subjects, setting, lighting, colors, mood. Label each as "Image 1:", "Image 2:", etc. 3-4 sentences each.`,
        }
      ];

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content }],
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
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ description: text }));
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

  // Build N scene prompts for a full video sequence
  if (req.url === '/build-scene-prompts' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) { res.writeHead(400, cors); res.end('Bad JSON'); return; }
      const { description, userGoal, numScenes = 3, storyArc, pacing, tone, subject, storyNotes, angle, lighting, movement, mood, focus, anthropicKey } = parsed;
      if (!anthropicKey) { res.writeHead(400, cors); res.end('Missing anthropicKey'); return; }

      // Assign a distinct shot type to each scene slot
      const shotProgression = [
        'EXTREME CLOSE-UP — fill the frame with a specific detail (face, hands, product surface, texture, eyes). Camera barely moves.',
        'MEDIUM SHOT from a completely different angle (side, 3/4 view, or behind). Subject clearly visible, environment partially visible.',
        'WIDE / FULL SHOT — subject small in a large environment, full body or full product visible, establishing the setting.',
        'LOW ANGLE — camera below eye level, looking up at the subject, dramatic and powerful.',
        'HIGH ANGLE / OVERHEAD — camera above, looking down. Subject surrounded by environment.',
        'OVER-THE-SHOULDER or POV — intimate perspective, as if through someone else\'s eyes or just behind the subject.',
      ];
      const assignedShots = Array.from({ length: numScenes }, (_, i) => shotProgression[i % shotProgression.length]);
      const shotList = assignedShots.map((s, i) => `Scene ${i+1}: ${s}`).join('\n');

      const systemPrompt = `You are an expert video director creating a ${numScenes}-scene video with STRICT subject consistency and intentional shot variety.

GOLDEN RULE — SUBJECT CONSISTENCY:
The EXACT SAME subject (same person, same product, same character) appears in EVERY scene with IDENTICAL appearance — same face, same hair color and style, same clothing, same product design and colors. Never change the subject's appearance between scenes.

GOLDEN RULE — SHOT VARIETY:
Each scene uses a COMPLETELY DIFFERENT camera distance, angle, and position. The setting/background ALSO changes between scenes to keep it visually fresh.

ASSIGNED SHOT TYPE PER SCENE (you MUST follow these):
${shotList}

For each scene prompt:
- Open by naming the shot type (e.g. "Extreme close-up —")
- Describe the subject's exact appearance briefly (for consistency reference)
- Describe the specific action/motion happening
- Describe the setting/environment (DIFFERENT from other scenes)
- Describe the lighting and camera movement
- Keep under 120 words
- Present tense, cinematic language

Return ONLY a valid JSON array of exactly ${numScenes} strings. No markdown, no labels, just the raw JSON array.`;

      const parts = [];
      if (description) parts.push(`VISUAL REFERENCE — study this carefully to extract the subject's exact appearance:\n${description}`);
      parts.push(`VIDEO CONCEPT:\nGoal: ${userGoal || 'Not specified'}\nMain Subject: ${subject || 'Not specified'}\nStory Arc: ${storyArc || 'Linear Journey'}\nPacing: ${pacing || 'Moderate'}\nTone: ${tone || 'Cinematic'}`);
      if (storyNotes) parts.push(`STORY NOTES (specific moments per scene):\n${storyNotes}`);
      parts.push(`PREFERRED CINEMATOGRAPHY (apply where possible, but shot type above takes priority):\nLighting: ${lighting || 'Natural'}\nCamera Movement: ${movement || 'Subtle, varies per scene'}\nMood/Style: ${mood || 'Cinematic'}\nFocus On: ${focus || 'Main subject'}`);

      const userMsg = parts.join('\n\n') + `\n\nGenerate exactly ${numScenes} scene prompts — same subject, different shot each time — as a JSON array:`;

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      };

      const proxy = https.request(options, upstream => {
        let data = '';
        upstream.on('data', d => data += d);
        upstream.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.error) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: result.error.message })); return; }
            const text = result.content[0].text.trim();
            const match = text.match(/\[[\s\S]*\]/);
            const scenes = match ? JSON.parse(match[0]) : [];
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ scenes }));
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

  // Build optimized video prompt via Claude
  if (req.url === '/build-video-prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) { res.writeHead(400, cors); res.end('Bad JSON'); return; }
      const { description, userGoal, angle, lighting, movement, mood, focus, anthropicKey } = parsed;
      if (!anthropicKey) { res.writeHead(400, cors); res.end('Missing anthropicKey'); return; }

      const systemPrompt = `You are an expert AI video prompt engineer specializing in models like Kling, Seedance, Wan, and MiniMax. Your job is to synthesize visual references, creative goals, and cinematography details into a single, highly optimized video generation prompt.

A great video prompt:
- Describes the subject(s) and their action/motion clearly
- Specifies camera angle and camera movement
- Includes lighting type and quality
- Sets the mood and atmosphere
- Notes what is prominently in focus
- Uses cinematic, present-tense language
- Is specific and vivid, not vague
- Is under 180 words

Output ONLY the final prompt text. No preamble, no explanation, no labels.`;

      const parts = [];
      if (description) parts.push(`VISUAL REFERENCE:\n${description}`);
      if (userGoal) parts.push(`VIDEO GOAL:\n${userGoal}`);
      if (angle) parts.push(`CAMERA ANGLE: ${angle}`);
      if (lighting) parts.push(`LIGHTING: ${lighting}`);
      if (movement) parts.push(`CAMERA MOVEMENT: ${movement}`);
      if (mood) parts.push(`MOOD/STYLE: ${mood}`);
      if (focus) parts.push(`FOCUS ON: ${focus}`);

      if (parts.length === 0) { res.writeHead(400, cors); res.end('No context provided'); return; }

      const userMsg = parts.join('\n\n') + '\n\nWrite the optimized video generation prompt now:';

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
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
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ prompt: text }));
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
