'use strict';
const axios  = require('axios');
const config = require('../../config');

const BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Fetch video metadata from YouTube Data API v3.
 * Returns null if video not found or API key missing.
 */
async function getVideoInfo(ytId) {
  if (!config.youtube.apiKey) {
    // Dev fallback – return stub so flows work without an API key
    return {
      ytId,
      title:       `YouTube video (${ytId})`,
      channelName: 'YouTube',
      durationSec: 240,
      embeddable:  true,
      thumbnail:   `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`,
    };
  }

  const res = await axios.get(`${BASE}/videos`, {
    params: {
      key:  config.youtube.apiKey,
      id:   ytId,
      part: 'snippet,contentDetails,status',
    },
    timeout: 8000,
  });

  const item = res.data.items?.[0];
  if (!item) return null;

  return {
    ytId,
    title:       item.snippet.title,
    channelName: item.snippet.channelTitle,
    durationSec: _iso8601ToSec(item.contentDetails.duration),
    embeddable:  item.status.embeddable,
    thumbnail:   item.snippet.thumbnails?.maxres?.url
                 || item.snippet.thumbnails?.high?.url,
  };
}

/**
 * Extract YouTube video ID from any YouTube URL format.
 * Returns null if not a valid YT URL.
 */
function extractVideoId(input) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = input.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Convert ISO 8601 duration (PT4M55S) to seconds */
function _iso8601ToSec(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600)
       + (parseInt(m[2] || 0) * 60)
       + parseInt(m[3] || 0);
}

module.exports = { getVideoInfo, extractVideoId };
