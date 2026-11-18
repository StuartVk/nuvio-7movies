#!/usr/bin/env node
// OPTIONAL fallback for the 7Movies plugin: a Stremio-style addon for Nuvio. Zero dependencies, Node >= 18.
//   node addon/server.js
//
// Why it exists: the BigBang master playlist URL that 7movies.ac hands out ends in ".m3u8.png" (the CDN only serves the file under that
// name). A player that picks its media source type from the URL extension (ExoPlayer does) can mistake it for an image/progressive file.
// This server loads ../providers/7movies.js unchanged and serves the same master playlist under a clean
//   http://<this device>:PORT/hls/movie/<tmdb>/master.m3u8        (tv: /hls/tv/<tmdb>/<season>/<episode>/master.m3u8)
// with every URI inside made absolute. Only that one small text file goes through this server; variant playlists, init segments and
// media segments are fetched by the player straight from the CDN (no bandwidth through this machine).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = +process.env.PORT || 7870;
const HOST = process.env.HOST || '0.0.0.0';
const VERBOSE = !!process.env.VERBOSE;
const TMDB_KEY = process.env.TMDB_KEY || '439c478a771f35c05022f9feabcca01c';   // same public key the other providers of this ecosystem use

const code = fs.readFileSync(path.join(ROOT, 'providers', '7movies.js'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version || '1.0.0';
let logs = [];
const sb = { console: { log: (...a) => { logs.push(a.join(' ')); } }, fetch, setTimeout, clearTimeout };
sb.global = sb;
vm.createContext(sb);
new vm.Script(code, { filename: '7movies.js' }).runInContext(sb);

// Nuvio id -> TMDB id (results are stable, so remember them)
const idCache = new Map();
async function resolveIds(type, rawId) {
  const parts = decodeURIComponent(rawId).split(':');
  if (parts[0] === 'tmdb' && /^\d+$/.test(parts[1] || '')) return { tmdb: parts[1], season: parts[2], episode: parts[3] };
  if (!/^tt\d+$/.test(parts[0])) return null;
  let tmdb = idCache.get(type + parts[0]);
  if (!tmdb) {
    const r = await fetch('https://api.themoviedb.org/3/find/' + parts[0] + '?api_key=' + TMDB_KEY + '&external_source=imdb_id');
    if (!r.ok) return null;
    const d = await r.json();
    const first = type === 'series' ? (d.tv_results || [])[0] || (d.movie_results || [])[0] : (d.movie_results || [])[0] || (d.tv_results || [])[0];
    if (!first) return null;
    idCache.set(type + parts[0], tmdb = String(first.id));
  }
  return { tmdb, season: parts[1], episode: parts[2] };
}

const inflight = new Map();
function providerStreams(tmdb, tv, season, episode) {
  const key = [tmdb, tv ? 'tv' : 'movie', season || '', episode || ''].join(':');
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    logs = [];
    const streams = await sb.getStreams(tmdb, tv ? 'tv' : 'movie', season ? +season : undefined, episode ? +episode : undefined);
    return { streams, logs };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function origin(req) { return 'http://' + (req.headers.host || ('127.0.0.1:' + PORT)); }

function localUrl(req, tv, tmdb, season, episode) {
  return origin(req) + '/hls/' + (tv ? 'tv/' + tmdb + '/' + (+season || 1) + '/' + (+episode || 1) : 'movie/' + tmdb) + '/master.m3u8';
}

const MANIFEST = {
  id: 'local.7movies.addon',
  version: VERSION,
  name: '7Movies',
  description: '7movies.ac (BigBang CDN HLS) with a clean .m3u8 master URL',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb:'],
  catalogs: []
};

function send(res, status, obj, extra) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}

// Make every URI of a playlist absolute against the URL it was fetched from.
function absolutize(text, base) {
  return text.split(/\r?\n/).map(l => {
    if (!l) return l;
    if (l[0] === '#') return l.replace(/URI="([^"]*)"/g, (m, u) => 'URI="' + new URL(u, base).toString() + '"');
    return new URL(l, base).toString();
  }).join('\n');
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/manifest.json') return send(res, 200, MANIFEST);

    let m = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(url.pathname);
    if (m) {
      const ids = await resolveIds(m[1], m[2]);
      if (!ids) { console.log('unsupported or unknown id ' + m[2]); return send(res, 200, { streams: [] }); }
      const tv = m[1] === 'series';
      const r = await providerStreams(ids.tmdb, tv, ids.season, ids.episode);
      console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + m[1] + ' ' + decodeURIComponent(m[2]) + ' -> ' + r.streams.length + ' stream(s), ' + (Date.now() - t0) + ' ms');
      if (VERBOSE || !r.streams.length) r.logs.forEach(l => console.log('    ' + l));
      const streams = r.streams.map(s => ({
        name: s.name,
        title: s.title,
        description: s.description,
        url: localUrl(req, tv, ids.tmdb, ids.season, ids.episode),
        subtitles: (s.subtitles || []).map((x, i) => ({ id: '7m-' + i, url: x.url, lang: x.lang || 'en' })),
        behaviorHints: { notWebReady: true, bingeGroup: '7movies-' + (s.quality || '') }
      }));
      return send(res, 200, { streams });
    }

    m = /^\/hls\/(?:movie\/(\d+)|tv\/(\d+)\/(\d+)\/(\d+))\/master\.m3u8$/.exec(url.pathname);
    if (m) {
      const tv = !!m[2];
      const r = await providerStreams(tv ? m[2] : m[1], tv, m[3], m[4]);
      if (!r.streams.length) { r.logs.forEach(l => console.log('    ' + l)); return send(res, 404, 'no stream'); }
      const s = r.streams[0];
      const up = await fetch(s.url, { headers: s.headers });
      if (!up.ok) return send(res, 502, 'upstream ' + up.status);
      const text = absolutize(await up.text(), s.url);
      console.log('[' + new Date().toTimeString().slice(0, 8) + '] master ' + url.pathname + ' ' + text.length + ' B, ' + (Date.now() - t0) + ' ms');
      return send(res, 200, text, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    }

    if (url.pathname === '/') return send(res, 200, '7Movies addon running. Add this in Nuvio:  http://<this device IP>:' + PORT + '/manifest.json\n');
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.log('ERROR', req.url, e && e.stack || e);
    send(res, 500, { streams: [], error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('7Movies addon v' + VERSION + ' listening on ' + HOST + ':' + PORT);
  const urls = ['http://127.0.0.1:' + PORT + '/manifest.json'];
  try {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(n => ifs[n].forEach(a => { if (a.family === 'IPv4' && !a.internal) urls.push('http://' + a.address + ':' + PORT + '/manifest.json'); }));
  } catch (e) { /* some Android builds block interface listing */ }
  console.log('Add one of these in Nuvio (Addons):\n  ' + urls.join('\n  '));
});
