'use strict';
/**
 * YouTube Routes — /api/youtube
 *
 * GET /validate?url=...    → validar URL y obtener metadata
 * GET /search?q=...        → buscar videos (para el panel del dueño)
 */

const router = require('express').Router();
const https  = require('https');
const { authenticate } = require('../middleware/auth');

const YT_API_BASE = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const YT_API_KEY  = process.env.YOUTUBE_API_KEY;

// ── Utilidad: petición HTTPS simple ─────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

/** Extrae el videoId de cualquier formato de URL de YouTube */
function extractYtId(url) {
  const patterns = [
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/** Convierte duración ISO 8601 (PT3M48S) → segundos */
function iso8601ToSeconds(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// ── GET /validate ────────────────────────────────────────────────

router.get('/validate', authenticate, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta el parámetro url.' });

  const videoId = extractYtId(url);
  if (!videoId) return res.status(400).json({ error: 'No se pudo detectar un ID de YouTube válido.' });

  // Sin API key → retornar solo el ID (modo degradado)
  if (!YT_API_KEY) {
    return res.json({
      videoId,
      title       : `Video (${videoId})`,
      channelTitle: 'Desconocido',
      duration    : 240, // fallback: 4 minutos
      durationStr : '4:00',
      thumbnail   : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      embeddable  : true,
    });
  }

  try {
    const apiUrl = `${YT_API_BASE}/videos?part=snippet,contentDetails,status&id=${videoId}&key=${YT_API_KEY}`;
    const data   = await httpsGet(apiUrl);

    if (!data.items || data.items.length === 0) {
      return res.status(404).json({ error: 'Video no encontrado o privado.' });
    }

    const item    = data.items[0];
    const dur     = iso8601ToSeconds(item.contentDetails.duration);
    const m       = Math.floor(dur / 60);
    const s       = dur % 60;

    res.json({
      videoId,
      title       : item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      description : item.snippet.description?.substring(0, 200),
      duration    : dur,
      durationStr : `${m}:${s.toString().padStart(2, '0')}`,
      thumbnail   : item.snippet.thumbnails?.high?.url
                 || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      embeddable  : item.status.embeddable,
      publishedAt : item.snippet.publishedAt,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar la API de YouTube.' });
  }
});

// ── GET /search ──────────────────────────────────────────────────

router.get('/search', authenticate, async (req, res) => {
  const { q, maxResults = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q.' });
  if (!YT_API_KEY) return res.status(503).json({ error: 'YouTube API key no configurada.' });

  try {
    const apiUrl = `${YT_API_BASE}/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=${maxResults}&key=${YT_API_KEY}`;
    const data   = await httpsGet(apiUrl);

    const results = (data.items || []).map(item => ({
      videoId     : item.id.videoId,
      title       : item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      thumbnail   : item.snippet.thumbnails?.high?.url
                 || `https://img.youtube.com/vi/${item.id.videoId}/hqdefault.jpg`,
      publishedAt : item.snippet.publishedAt,
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar en YouTube.' });
  }
});

module.exports = router;
