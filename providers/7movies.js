// 7Movies (7movies.ac) provider for Nuvio. Promise-based on purpose (no async/await), plain ES5, no WebAssembly / Buffer / TextEncoder.
//
// How 7movies.ac plays something (verified by hand, see README):
//   title page  https://7movies.ac/movie/<tmdb>  ->  /watch page puts an <iframe> on https://embed.vidrift.net/embed2/play#type=movie&id=<tmdb>...
//   the embed's JS calls  GET https://embed.vidrift.net/api/boot/movie/<tmdb>   (tv: /api/boot/tv/<tmdb>/<season>/<episode>)
//   and gets JSON  { meta: { bigbangUrl, bigbangSubtitles, vexonUrl, evionUrl, orionStreams, ... } }.
//   bigbangUrl is a ready-signed, header-free HLS master (fMP4 segments, 8 audio languages, up to 2160p H.264).
// The embed only hands out streams when the x-embed-parent request header names a whitelisted embedding site (7movies.ac).
// embed.vidrift.net additionally sits behind a Cloudflare bot rule (403 "Attention Required" unless the request looks like a browser
// fetch: sec-fetch-mode: cors, and from some HTTP stacks, e.g. Node's, it 403s regardless). The mirror embed.vidrift.in, which the
// 7movies CSP also lists as a frame source, serves the identical API without that rule, so it is tried first and .net is the fallback.
// The returned HLS URL itself needs NO headers or cookies.
//
// Returns ONE stream, "7Movies - BigBang (Auto)", pointing at the master playlist (the player picks the video variant).

var EMBEDS = ['https://embed.vidrift.in', 'https://embed.vidrift.net'];   // identical API; .in has no bot rule, .net has
var PARENT = 'https://7movies.ac';                       // value the site's own page sends as x-embed-parent (the embed whitelists it)
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var REQUEST_TIMEOUT_MS = 12000;
var WANT_SUBTITLES = true;     // inline ONE English subtitle as a data: URI (the .vtt URLs end in .png, which players do not guess)
var MAX_SUBTITLE_BYTES = 400000;
var CACHE_MS = 5 * 60 * 1000;  // signed URLs are good for hours; 5 minutes is plenty for re-opening the same title
var DEBUG = true;
var T0 = Date.now();
function log() { if (DEBUG) console.log.apply(console, ['[7Movies +' + (Date.now() - T0) + 'ms]'].concat([].slice.call(arguments))); }

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4));
    s += i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=';
    s += i + 2 < bytes.length ? B64.charAt(c & 63) : '=';
  }
  return s;
}

function withTimeout(p, ms, what) {
  if (typeof setTimeout !== 'function') return p;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout ' + what)); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

// Headers the embed's own JS sends from inside the iframe (same-origin fetch). Without sec-fetch-mode the WAF answers 403.
function embedHeaders(embed) {
  return {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': embed + '/embed2/play',
    'x-embed-parent': PARENT,
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-dest': 'empty'
  };
}

function bootPath(mediaType, tmdbId, season, episode) {
  if (mediaType === 'tv') return '/api/boot/tv/' + encodeURIComponent(tmdbId) + '/' + (parseInt(season, 10) || 1) + '/' + (parseInt(episode, 10) || 1);
  return '/api/boot/movie/' + encodeURIComponent(tmdbId);
}

// Tries each embed host in order; a host counts as failed on an HTTP error, a network error, or a reply without a bigbangUrl.
function boot(mediaType, tmdbId, season, episode) {
  var path = bootPath(mediaType, tmdbId, season, episode), last = {};
  function attempt(i) {
    if (i >= EMBEDS.length) return Promise.resolve(last);
    var host = EMBEDS[i];
    return withTimeout(fetch(host + path, { headers: embedHeaders(host) }), REQUEST_TIMEOUT_MS, host + path).then(function (r) {
      log('HTTP', r.status, host + path);
      if (!r.ok) throw new Error('boot HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var meta = (j && j.meta) || {};
      if (meta.bigbangUrl) return meta;
      last = meta;
      return attempt(i + 1);
    }).catch(function (e) {
      log('boot failed on', host, String(e && e.message || e));
      return attempt(i + 1);
    });
  }
  return attempt(0);
}

// Language names of the master's audio renditions, only for the stream description.
function audioNames(master) {
  var out = [], re = /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*?NAME="([^"]+)"/g, m;
  while ((m = re.exec(master))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

function topHeight(master) {
  var h = 0, re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)/g, m;
  while ((m = re.exec(master))) h = Math.max(h, +m[1]);
  return h;
}

function heightText(h) {
  if (h >= 2000) return '4K';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h > 0) return h + 'p';
  return 'Auto';
}

function fetchEnglishSubtitle(meta) {
  if (!WANT_SUBTITLES) return Promise.resolve([]);
  var list = meta.bigbangSubtitles || [], en = null;
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].lang === 'en' && list[i].url) { en = list[i]; break; }
  if (!en) return Promise.resolve([]);
  return withTimeout(fetch(en.url, { headers: { 'User-Agent': USER_AGENT } }), REQUEST_TIMEOUT_MS, 'subtitle').then(function (r) {
    return r.ok ? r.text() : '';
  }).then(function (txt) {
    if (!txt || txt.indexOf('WEBVTT') !== 0 || txt.length > MAX_SUBTITLE_BYTES) return [];
    return [{ url: 'data:text/vtt;base64,' + base64(utf8Bytes(txt)), label: 'English', lang: 'en' }];
  }).catch(function (e) { log('subtitle ERROR', String(e && e.message || e)); return []; });
}

var cache = {};

function getStreams(tmdbId, mediaType, season, episode) {
  var isTv = mediaType === 'tv' || mediaType === 'series';
  var type = isTv ? 'tv' : 'movie';
  var key = [tmdbId, type, isTv ? season || 1 : '', isTv ? episode || 1 : ''].join(':');
  var hit = cache[key];
  if (hit && Date.now() - hit.t < CACHE_MS) { log('cache hit', key); return Promise.resolve(hit.v); }
  T0 = Date.now();
  log('getStreams', tmdbId, type, season, episode);
  return boot(type, tmdbId, season, episode).then(function (meta) {
    if (!meta.bigbangUrl) { log('no bigbangUrl (title not on the BigBang CDN, or the embed gate refused x-embed-parent)'); return []; }
    return withTimeout(fetch(meta.bigbangUrl, { headers: { 'User-Agent': USER_AGENT } }), REQUEST_TIMEOUT_MS, 'master').then(function (r) {
      log('HTTP', r.status, 'master');
      return r.ok ? r.text() : '';
    }).then(function (master) {
      if (!master || master.indexOf('#EXTM3U') !== 0) { log('master playlist unavailable'); return []; }
      var h = topHeight(master), audio = audioNames(master), q = heightText(h);
      return fetchEnglishSubtitle(meta).then(function (subs) {
        var v = [{
          name: '7Movies - BigBang (Auto)',
          title: 'BigBang - ' + q + (audio.length ? ' | ' + audio.length + ' audio' : '') + (subs.length ? ' | subs' : ''),
          description: 'Source: BigBang CDN via embed.vidrift | adaptive HLS (fMP4, H.264)' + (audio.length ? ' | audio: ' + audio.join(', ') : ''),
          url: meta.bigbangUrl,
          quality: q,
          type: 'hls',
          headers: { 'User-Agent': USER_AGENT },
          subtitles: subs
        }];
        cache[key] = { t: Date.now(), v: v };
        return v;
      });
    });
  }).catch(function (e) { log('FATAL', String(e && e.message || e)); return []; });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams: getStreams, _internals: { bootPath: bootPath, audioNames: audioNames, topHeight: topHeight, embedHeaders: embedHeaders } };
else { global.getStreams = getStreams; }
