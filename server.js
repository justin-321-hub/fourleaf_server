// 說明：Express 後端，提供靜態前端 + API：/api/whisper /api/n8n /api/tts
// 需求：Node 18+ (原生 fetch)、dotenv、express、multer、cors

require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');        // 處理 multipart/form-data
const cors = require('cors');

const app = express();

/* =========================
   CORS（允許 GitHub Pages 來源）
   ========================= */
app.use(cors({
  origin: ['https://justin-321-hub.github.io'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));
app.options('*', cors());

/* =========================
   通用中介層
   ========================= */
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* 健康檢查 */
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* Multer：限制錄音檔大小（20MB） */
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

/* =========================
   Whisper 代理：前端錄音 → OpenAI STT
   - 改用 Node 原生 FormData/Blob（避免第三方 form-data 相容性問題）
   ========================= */
app.post('/api/whisper', upload.single('file'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: '缺少 OPENAI_API_KEY' });
  }
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: '缺少音訊檔 (field: file)' });
  }

  try {
    const mime = req.file.mimetype || 'audio/webm';
    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: mime });

    // 欄位名必須是 file；檔名可固定為 audio.webm（或依 mime 決定）
    form.append('file', blob, 'audio.webm');
    form.append('model', 'whisper-1');
    // form.append('language', 'zh'); // 可選：指定語言提升準確率

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        // 不要自行帶 multipart boundary，讓 fetch 依 form 自動設定
      },
      body: form
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('[whisper] upstream error:', r.status, errText);
      return res.status(r.status).json({ error: errText || 'Whisper API error' });
    }

    const data = await r.json(); // { text: "..." }
    return res.status(200).json(data);
  } catch (err) {
    console.error('[whisper] fetch failed:', err?.name, err?.message);
    return res.status(502).json({ error: err?.message || 'Whisper API error' });
  }
});

/* =========================
   n8n 代理：文字 → 你的 n8n Webhook
   ========================= */
app.post('/api/n8n', async (req, res) => {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_URL' });

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 某些 WAF/Cloudflare 對沒有 UA 的請求會擋
        'User-Agent': 'fourleaf-proxy/1.0'
      },
      body: JSON.stringify(req.body || {})
    });

    const ct = r.headers.get('content-type') || '';

    if (!r.ok) {
      const errText = await r.text();
      console.error('[n8n] upstream error:', r.status, errText);
      return res.status(r.status).json({
        error: 'n8n error',
        status: r.status,
        body: errText
      });
    }

    if (ct.includes('application/json')) {
      const data = await r.json();
      return res.status(200).json(data);
    } else {
      const text = await r.text();
      return res.status(200).json({ text });
    }
  } catch (err) {
    console.error('[n8n] fetch failed:', err?.name, err?.message, err?.cause?.code);
    return res.status(502).json({
      error: 'Upstream fetch failed',
      detail: err?.message || String(err)
    });
  }
});

/* =========================
   OpenAI TTS：文字 → 語音音檔
   ========================= */
app.post('/api/tts', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: '缺少 OPENAI_API_KEY' });
  }

  try {
    const { text, voice = 'alloy', format = 'mp3' } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: '缺少 text 內容' });

    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice,   // alloy/onyx/nova/sage/shimmer…
        format   // mp3/opus/aac/flac/wav/pcm
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('[tts] upstream error:', r.status, errText);
      return res.status(r.status).json({ error: errText || 'TTS error' });
    }

    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);

    const contentTypes = {
      mp3: 'audio/mpeg',
      opus: 'audio/ogg; codecs=opus',
      aac: 'audio/aac',
      flac: 'audio/flac',
      wav: 'audio/wav',
      pcm: 'audio/l16'
    };
    res.setHeader('Content-Type', contentTypes[format] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="speech.${format}"`);
    return res.status(200).end(buf);
  } catch (err) {
    console.error('[tts] fetch failed:', err?.name, err?.message);
    return res.status(500).json({ error: err?.message || 'TTS proxy error' });
  }
});

/* =========================
   啟動服務
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
