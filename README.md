# Nuvio 7Movies

Movies and TV from [7movies.ac](https://7movies.ac) for Nuvio. **A plain plugin is enough** (`providers/7movies.js`). An optional tiny addon (`addon/server.js`) is included in case the player will not accept the plugin's playlist URL.

7movies.ac is only a front end. Its player is an iframe on `embed.vidrift.net`, which exposes `GET /api/boot/movie/<tmdb>` (TV: `/api/boot/tv/<tmdb>/<season>/<episode>`). The JSON reply contains `meta.bigbangUrl`, a ready-signed HLS master (`?exp=..&sig=..`) on the BigBang CDN. The CDN needs **no cookie, header or token**, and segments are plain fMP4 (no encryption), so a plugin that only returns the URL is enough.

## Add the plugin in Nuvio

1. Put this folder in a GitHub repo (or any static host) so `manifest.json` has a raw URL, for example `https://raw.githubusercontent.com/<you>/nuvio-7movies/main/manifest.json`.
2. Nuvio: Settings, Plugins (Local Scrapers), add that manifest URL.
3. Nothing to configure. It returns one stream, "7Movies - BigBang (Auto)": adaptive master, up to 4K on some movies and 1080p on most episodes, several audio languages (English is the default track), English subtitle attached.

## Optional addon (Node >= 18, no dependencies)

```
node addon/server.js          # listens on 0.0.0.0:7870 (PORT=... to change, VERBOSE=1 for provider logs)
```

Add `http://<device IP>:7870/manifest.json` in Nuvio under Addons. It supports `tt...` (IMDb, resolved through TMDB) and `tmdb:` ids for `movie` and `series` (`tt0903747:1:1`, `tmdb:1396:1:1`). It loads the plugin file unchanged and serves the master as `http://<host>:7870/hls/movie/<tmdb>/master.m3u8` (TV: `/hls/tv/<tmdb>/<season>/<episode>/master.m3u8`) with absolute URIs. Only that small text file passes through the server; variants and segments come straight from the CDN. Use it if the plugin stream fails to start in your player.

## Known limits

- **The master URL ends in `.m3u8.png`.** The CDN only serves the file under that name. Players that choose the source type from the URL extension may not treat it as HLS. I could not test this on a real Nuvio/ExoPlayer, which is why the addon exists (clean `.m3u8` URL).
- **Which embed host is used matters.** `embed.vidrift.net` sits behind a Cloudflare bot rule (403 "Attention Required" for some HTTP stacks, including Node's `fetch`, even with browser headers). The mirror `embed.vidrift.in` has no such rule and returns the same data, so the plugin tries `.in` first and `.net` second. If `.in` ever gets the same rule, the plugin returns no streams.
- **`x-embed-parent: https://7movies.ac` is required.** Without a whitelisted parent the API answers with empty stream fields. It is a plain header; nothing to configure.
- Signed URLs last about 12 hours. The plugin caches a title for 5 minutes only.
- Titles that BigBang does not host (including obscure titles and unreleased episodes) return no streams. Other sources the embed knows (Vexon/Evion, Orion) are not used: Vexon/Evion variant playlists answered 403 to every request I made, and Orion is HEVC with host-gated requests.
- Some movies list a 2160p variant at about 16 Mbit/s next to a 1280x532 one; adaptive switching is the player's job.
- Only the English subtitle is attached (inlined as a `data:` URI). The master playlist also lists about 16 subtitle languages that players such as ExoPlayer pick up themselves.
- The site, its embed and the CDN are third-party services and can change without notice.
