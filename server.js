const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== 設定 ==========
const PORT = 8080;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'YOUR_API_KEY_HERE';

// ========== 静的ファイル配信 ==========
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ========== Claude API プロキシ ==========
async function handleDiagnose(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let params;
  try {
    params = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const { maker, model, grade, year, mileage, repair, customParts, investment } = params;

  const prompt = `あなたは中古車市場の価格査定の専門家です。以下の車両情報に基づいて、日本の中古車市場（グーネット、カーセンサー）での相場を分析してください。

車両情報:
- メーカー: ${maker}
- 車種: ${model}
${grade ? `- グレード: ${grade}` : ''}
- 年式: ${year}年
- 走行距離: ${Number(mileage).toLocaleString()}km
- 修復歴: ${repair}
${customParts ? `- カスタムパーツ: ${customParts}` : ''}
${investment ? `- カスタム投資額: ${Number(investment).toLocaleString()}円` : ''}

以下の形式のJSONのみを返してください（説明文不要）:
{
  "shopPrice": <店頭販売価格（万円、整数）>,
  "tradeIn": <一般下取り価格（万円、整数）>,
  "comment": "<100文字以内の市場分析コメント>"
}`;

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Claude API error:', apiRes.status, errText);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API error', status: apiRes.status }));
      return;
    }

    const data = await apiRes.json();
    const text = data.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to parse API response' }));
    }
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server error' }));
  }
}

// ========== サーバー ==========
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoint
  if (req.method === 'POST' && req.url === '/api/diagnose') {
    handleDiagnose(req, res);
    return;
  }

  // Static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CarMatch server running at http://localhost:${PORT}`);
  if (CLAUDE_API_KEY === 'YOUR_API_KEY_HERE') {
    console.log('⚠️  CLAUDE_API_KEY が未設定です。環境変数で設定してください:');
    console.log('   CLAUDE_API_KEY=sk-ant-... node server.js');
    console.log('   → APIキーなしでも内蔵データで動作します');
  } else {
    console.log('✅ Claude API 連携が有効です');
  }
});
