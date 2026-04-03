const http = require('http');
const https = require('https');
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
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ========== グーネット スクレイピング ==========
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      timeout: 10000,
    }, (res) => {
      // リダイレクト対応
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function scrapeGoonet(maker, model, year) {
  try {
    // グーネットの検索URLを構築（ブランド名で検索）
    const query = encodeURIComponent(`${maker} ${model} ${year}年`);
    const searchUrl = `https://www.goo-net.com/usedcar/spread/goo/13/700/${query}.html`;

    console.log(`[Scrape] Fetching: ${searchUrl}`);
    const html = await fetchUrl(searchUrl);

    // 価格情報を抽出（正規表現で価格パターンを検索）
    const prices = [];

    // パターン1: "XX万円" or "XX.X万円"
    const pricePattern = /(\d{1,4}(?:\.\d)?)\s*万円/g;
    let match;
    while ((match = pricePattern.exec(html)) !== null) {
      const price = parseFloat(match[1]);
      if (price >= 10 && price <= 9999) { // 妥当な範囲のみ
        prices.push(price);
      }
    }

    // パターン2: "本体価格" 近辺の価格
    const bodyPricePattern = /本体価格[^0-9]*?(\d{1,4}(?:\.\d)?)\s*万円/g;
    while ((match = bodyPricePattern.exec(html)) !== null) {
      const price = parseFloat(match[1]);
      if (price >= 10 && price <= 9999) prices.push(price);
    }

    if (prices.length === 0) {
      console.log('[Scrape] No prices found in goo-net, trying carsensor...');
      return await scrapeCarsensor(maker, model, year);
    }

    // 統計
    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const min = prices[0];
    const max = prices[prices.length - 1];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

    console.log(`[Scrape] Found ${prices.length} prices. Min:${min}万 Max:${max}万 Avg:${avg}万 Median:${median}万`);

    return {
      source: 'goo-net',
      count: prices.length,
      min: Math.round(min),
      max: Math.round(max),
      avg,
      median: Math.round(median),
      prices: prices.slice(0, 20), // 上位20件
    };
  } catch (err) {
    console.error('[Scrape] Goo-net error:', err.message);
    return await scrapeCarsensor(maker, model, year);
  }
}

async function scrapeCarsensor(maker, model, year) {
  try {
    const query = encodeURIComponent(`${maker} ${model} ${year}`);
    const searchUrl = `https://www.carsensor.net/usedcar/search.php?STID=CS210610&CAESSION=U&KEYWORD=${query}`;

    console.log(`[Scrape] Fetching carsensor: ${searchUrl}`);
    const html = await fetchUrl(searchUrl);

    const prices = [];
    const pricePattern = /(\d{1,4}(?:\.\d)?)\s*万円/g;
    let match;
    while ((match = pricePattern.exec(html)) !== null) {
      const price = parseFloat(match[1]);
      if (price >= 10 && price <= 9999) prices.push(price);
    }

    if (prices.length === 0) {
      console.log('[Scrape] No prices found in carsensor either');
      return null;
    }

    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

    console.log(`[Scrape] Carsensor: ${prices.length} prices. Avg:${avg}万 Median:${Math.round(median)}万`);

    return {
      source: 'carsensor',
      count: prices.length,
      min: Math.round(prices[0]),
      max: Math.round(prices[prices.length - 1]),
      avg,
      median: Math.round(median),
      prices: prices.slice(0, 20),
    };
  } catch (err) {
    console.error('[Scrape] Carsensor error:', err.message);
    return null;
  }
}

// ========== Claude API プロキシ（スクレイピングデータ付き） ==========
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

  // Step 1: グーネット/カーセンサーから実際の価格を取得
  let marketData = null;
  try {
    marketData = await scrapeGoonet(maker, model, year);
  } catch (err) {
    console.error('[Scrape] Failed:', err.message);
  }

  // Step 2: Claude APIに市場データ付きで問い合わせ
  if (CLAUDE_API_KEY === 'YOUR_API_KEY_HERE') {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API key not set' }));
    return;
  }

  const marketInfo = marketData
    ? `\n\n【実際の中古車市場データ（${marketData.source}より取得）】
- 掲載台数: ${marketData.count}台
- 価格帯: ${marketData.min}万円 〜 ${marketData.max}万円
- 平均価格: ${marketData.avg}万円
- 中央値: ${marketData.median}万円
※これは同車種の実際の掲載データです。この情報を重視して価格を算出してください。`
    : '\n\n※市場データの取得に失敗しました。あなたの知識から最新の中古車相場を推定してください。';

  const prompt = `あなたは日本の中古車市場に精通した査定士です。グーネットやカーセンサーで実際に掲載されている価格帯を熟知しています。

以下の車両が「今日、中古車販売店の店頭で売られるとしたらいくらか」を、現実の市場相場に基づいて正確に算出してください。

【重要な注意】
- 年式が古い車（10年以上）や走行距離が多い車（10万km以上）は大幅に価格が下がります
- 例：2014年式・12万kmのスカイラインハイブリッドなら店頭100〜150万円程度が現実的
- 下取り価格は店頭価格の40〜55%程度（年式が古いほど比率が下がる）
- 新車価格ではなく、実際の中古車流通価格を答えてください
- 高く見積もりすぎないこと。ユーザーが実際に売る時にガッカリしない価格を出すこと

車両情報:
- メーカー: ${maker}
- 車種: ${model}
${grade ? `- グレード: ${grade}` : ''}
- 年式: ${year}年（${2026 - year}年落ち）
- 走行距離: ${Number(mileage).toLocaleString()}km
- 修復歴: ${repair}
${customParts ? `- カスタムパーツ: ${customParts}` : ''}
${investment ? `- カスタム投資額: ${Number(investment).toLocaleString()}円` : ''}
${marketInfo}

以下の形式のJSONのみを返してください（説明文不要）:
{
  "shopPrice": <中古車販売店の店頭価格（万円、整数）>,
  "tradeIn": <ディーラー下取り価格（万円、整数）>,
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
        max_tokens: 400,
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
      // 市場データ情報も含めて返す
      if (marketData) {
        result.marketData = {
          source: marketData.source,
          count: marketData.count,
          min: marketData.min,
          max: marketData.max,
          avg: marketData.avg,
        };
      }
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/diagnose') {
    handleDiagnose(req, res);
    return;
  }

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
    console.log('✅ Claude API + 市場データスクレイピング 有効');
  }
});
