# Streaming providers for OpenDJ: research, verdicts and plan

*Researched 2026-11-21 for OpenDJ (MIT; Electron, web, Capacitor iOS/Android). This document is research, not legal advice.*

> **Owner's rule:** "please add any possible free integrations without permission. anything that can land us in trouble, please leave out."
>
> **Classification:**
> - **SAFE:** free, no partner application, the terms explicitly allow streaming with audio processing (DJ use), no DRM workaround, no scraping, and it works with an open-source client.
> - **NOT SAFE:** any doubt at all.

## 0. Summary for the owner

- **YouTube Music / YouTube audio: NOT ALLOWED.**
  - Google has no official YouTube Music API.
  - The YouTube API policies forbid separating audio from video and forbid downloading.
  - The IFrame player is a cross-origin iframe, so its audio can't reach our Web Audio graph.
  - Keep the existing video-visuals feature (`public/js/video/youtube.js`) exactly as it is: official player, visible, with its own audio.
- **Spotify, Apple Music, TIDAL, SoundCloud, Beatport (Beatsource merged into it in 2026) and Amazon Music** need a signed partner deal, and Spotify also bans DJ use in its public API. **Deezer**'s API has been disabled since June 2025. None of these can be added without permission.
- **Audius** (free, open API) was checked in full. **NOT SAFE: leave out.** The licence doesn't grant modification, which DJ mixing requires (§2.1-C). A CC BY-only mode would be legally clean but covers about 0.3% of tracks. **Recommendation: don't build it.**
- **Jamendo, Internet Archive, Free Music Archive, Bandcamp and Freesound: NOT SAFE or out of scope** (§2.3).
- **SAFE, and already shipped:** self-hosted servers (Navidrome/Subsonic, Jellyfin, Emby, Plex, MediaMax) and local files from DRM-free download stores. The only work to do is UI and help text that points DJs to them (§3.1).

## 1. Summary table

| Provider | DJ use / processing allowed for third parties? | Access | Feasible now? | Effort | Verdict |
|---|---|---|---|---|---|
| Self-hosted (Navidrome/Subsonic, Jellyfin, Emby, Plex, MediaMax) | Yes, it is the user's own files | Already built | Shipped | 0 | **SAFE (keep and promote)** |
| Purchased DRM-free downloads (Bandcamp, Beatport, Juno and other stores) as local files | Yes, within each store's personal licence | User buys and imports | Shipped | S (help text) | **SAFE (document)** |
| Audius, default tracks (OML / "All rights reserved" / no licence) | Stream and perform yes; **modify not granted** | Free self-serve key; read calls also work keyless today | Technically yes | M | **NOT SAFE: leave out** |
| Audius, CC BY tracks only | Yes (CC BY 4.0 allows commercial use and adaptation) | Same | Yes | M | **Passes the rule, but about 0.3% of tracks. Not recommended.** |
| Audius, CC BY-SA, BY-NC*, BY-ND tracks | SA is unclear for live mixes; NC can't be guaranteed; ND forbids adaptation | Same | n/a | n/a | **NOT SAFE** |
| Jamendo | Free API is non-commercial only | Self-serve `client_id` | n/a | n/a | **NOT SAFE** |
| Internet Archive | Rights vary per item; licence metadata is unreliable | No key | n/a | n/a | **NOT SAFE** |
| Free Music Archive | API reportedly shut down | n/a | No | n/a | **NOT SAFE** |
| Bandcamp | No public API; only scraping | n/a | No | n/a | **NOT SAFE** (use purchased files) |
| Freesound | Samples, not tracks | Self-serve key | Off-topic | n/a | Out of scope |
| YouTube / YouTube Music | **Forbidden** | n/a | No | n/a | **NOT ALLOWED** |
| Spotify | Public API bans "DJ/Mixes"; DJ apps have private deals | Partner only | No | n/a | **NOT ALLOWED** |
| Apple Music | Partners only; FairPlay DRM | Partner deal, no public form | No | n/a | **Partner only** |
| TIDAL | DJ Extension for partners; public SDK playback is DRM | Partner deal | No | n/a | **Partner only** |
| SoundCloud | API terms forbid modifying content; DJ access is partner only | Application, then deal | No | n/a | **Partner only / NOT SAFE** |
| Beatport Streaming (incl. ex-Beatsource) | Partners only | Business-development deal | No | n/a | **Partner only** |
| Amazon Music | Closed beta | Business-development contact | No | n/a | **NOT AVAILABLE** |
| Deezer | API disabled since June 2025 | n/a | No | n/a | **NOT AVAILABLE** |

## 2. Verdicts

### 2.1 SAFE / checked candidates

**A. Self-hosted media servers: SAFE (already shipped).**
- The content is the user's own, on their own server.
- Credentials are supplied by the user and bound to the endpoint (`sourceConfigFromForm` in `public/js/shared/sources/index.js`).

**B. Purchased downloads: SAFE (already shipped as the local library).**
- Bandcamp sells MP3 320/V0, AAC, Ogg, FLAC, ALAC, WAV and AIFF downloads ([Wikipedia](https://en.wikipedia.org/wiki/Bandcamp)). Beatport, Juno and similar stores sell DJ files.
- Point users to these stores. Never integrate with or scrape a store.

**C. Audius: NOT SAFE (verified 2026-11-21 against the full documents).**

The documents, read in full:
- **Open Music License (OML):** [audius.org/open-music-license.pdf](https://audius.org/open-music-license.pdf), last updated 2 July 2025. That URL now redirects to openaudiofoundation.org, which this session couldn't reach. I read the identical file published in Audius's own repo: [raw.githubusercontent.com/AudiusProject/audius.org/main/public/open-music-license.pdf](https://raw.githubusercontent.com/AudiusProject/audius.org/main/public/open-music-license.pdf).
- **API Terms:** [ApiTerms.pdf](https://audius.co/documents/ApiTerms.pdf), 2 July 2025.
- **Terms of Use:** [TermsOfUse.pdf](https://audius.co/documents/TermsOfUse.pdf), 5 October 2025.

Each question, with the clauses quoted:

1. **Modification (tempo, pitch, EQ, effects, overlap): not granted. This is the deciding point.**
   - OML §1.2: "Licensor hereby grants to Music Players a worldwide, non-exclusive, royalty-free, perpetual, irrevocable right and license, with the right to sublicense, to reproduce, publicly perform, distribute, electronically or digitally transmit, stream, and otherwise use in whole or part, the Licensed Material, in connection with a Music Player's services." The list has no "modify", "adapt" or "make derivative works".
   - OML §1.6: "Licensor reserves all rights and licenses in and to the Licensed Materials not expressly granted to Licensees under this OML."
   - By contrast, the Terms of Use grant **Audius itself** the right to "use, copy, reproduce, display, distribute, publish, **modify, adapt, make derivative works of**…". The OML wording for third-party players leaves those verbs out. That contrast reads as deliberate.
   - Terms of Use: "Any Content… may not be used, **modified**, reproduced… **transformed**, redesigned, reconfigured, retransmitted… except as facilitated by the tools… of the Audius Service… or without the express prior written consent of Company, the applicable Creator…" The Terms of Use say third-party use is "governed… rather [by] the API Terms and the Open Music License", but this still shows how Audius frames modification.
   - [Audius blog, 8 July 2025](https://blog.audius.co/posts/audius-terms-of-service-update): uploads default to "All Rights Reserved… no one may copy, remix, or modify a track without the artist's permission."
   - → For default-licensed tracks this is ambiguous at best, so it is **NOT SAFE**.
   - CC tracks are different. The Terms of Use say artists may choose "CC BY (Attribution)… permitting commercial use and derivatives with attribution" and five other CC licences. In the API, the track's `license` field shows the choice. Only **CC BY** is free of doubt:
     - **CC BY-SA:** ShareAlike applies when you "Share" adapted material, and CC 4.0 defines Share to include public performance. A live mix with other tracks can't meet SA, so it's ambiguous.
     - **BY-NC / BY-NC-SA / BY-NC-ND:** we can't guarantee the use is non-commercial.
     - **BY-ND:** no derivatives at all.
2. **Public performance at paid events.**
   - OML §1.2 grants "publicly perform" to Music Players "with the right to sublicense". The preamble says Licensees include "Music Players and their sublicensees".
   - The Terms of Use's Listener licence is "personal and non-commercial use", but it governs use of the Audius Service itself, not third-party players.
   - Performance itself is covered. Performing **modified** audio is not (point 1).
   - Collecting-society licences (PRS, ASCAP and so on) are outside Audius's grant either way.
3. **Recording / broadcasting mixes.**
   - OML: "reproduce… distribute… transmit… in connection with a Music Player's services" only. A recording that leaves the app goes beyond that, and it would contain modified audio.
   - CC BY allows it, provided there is attribution and modifications are indicated (CC BY 4.0 §3(a)).
4. **Caching.** API Terms, "Content and Data Protection": "you may only use **session-based caching** to the extent necessary for the operation of the API or App during that respective session; any cached content or consumer data **must become inaccessible and unavailable upon termination of the respective session**. Consumer setting changes must be updated and implemented promptly upon receipt."
   - Therefore: no offline audio, and no persisted metadata.
   - Persisted derived analysis (waveforms, beatgrids) is ambiguous, so treat it as session-only too.
5. **Downloads: no.** Terms of Use: "the Audius Service is for **active streaming use only**, and in no event is it to be used for downloading and/or local serving." Content may not be "downloaded (unless permitted by a Creator…)".
6. **Attribution.** OML §1.5, for commercial use, requires all of these:
   - "(a) identification of the Licensor (including by pseudonym if designated)…"
   - "(b) a copyright notice reflecting the copyright owner…"
   - "(c) a notice that refers to this OML"
   - "(d) a URI or hyperlink to the Licensed Material…"
   - "(e) If requested by the Licensor, Licensee must remove any of the information required by Section 1.5(a)…"
   - CC BY adds a licence notice and link, and an indication of modifications.
7. **Rate limits.**
   - The [api.audius.co/plans](https://api.audius.co/plans) page (strings from its bundle): Free plan "No Restrictions. Always Free.", `freeRateLimit:"10"` requests per second, `freeMonthlyLimit:"500,000"` requests per month. Unlimited plan via api@audius.co.
   - A single project key shared by every install would exhaust 500k a month quickly, so each user should bring their own key.
8. **Key handling in a public client.**
   - [audius.co/agents.md](https://audius.co/agents.md): "Read-only access uses API Key only. Writes (upload, favorite, etc.) require API Secret—**never expose it on the frontend**."
   - The plans page: "Redirect URIs… Required when using **OAuth2 PKCE** to obtain user access tokens." The official examples are front-end Vite and Expo apps.
   - → The API key may be public. The secret / bearer token must never ship. User login uses PKCE.
   - API Terms: "You agree to provide the users of your App(s)… with the Audius Privacy Policy and these API Terms."
9. **Termination and takedown.**
   - API Terms: "Licensor may immediately terminate these API Terms for any reason, without notice… Upon any termination… Licensee will promptly cease all access to and use of the API."
   - OML §3.1: rights to a track "terminate automatically" on non-compliance. §3.2: they are reinstated if the violation is cured within 30 days and written notice is given.
   - Audius complies with the DMCA. Notices go to dmca@audius.co (Terms of Use).
   - The API Terms also make the project (the "Licensee") **indemnify** Audius, accept **binding arbitration** in California, and accept a **$50 liability cap**. Audius may change the terms at any time; continued use counts as acceptance.
   - OML §1.7 says uploaders warrant their rights and "shall indemnify and hold harmless Music Players". The real-world value of that against anonymous uploaders is low. Example: the live sample included "SOPHIE - UNISIL MASHUP", marked CC BY-NC by its uploader.

Live test results (read-only, `app_name=OpenDJ`, no key):
- `GET https://api.audius.co/v1/tracks/trending?app_name=OpenDJ&limit=3` → **200**, `access-control-allow-origin: *`, so no key is currently required.
  - The track JSON includes `license`, `bpm`, `musical_key`, `is_streamable`, `is_stream_gated`, `stream_conditions`, `allowed_api_keys`, `access{stream,download}`, `is_downloadable` and `permalink`.
- `GET /v1/tracks/V66vyPP/stream?app_name=OpenDJ` → **302** to a signed, timestamped `creatornode.audius.co/tracks/cidstream/…` URL, with `ACAO: *`.
  - An OPTIONS preflight returns 204 and allows the `range` header.
  - **UNVERIFIED:** the CORS and Range headers on the content node itself (this session's proxy blocked creatornode.audius.co).
- Licence mix in 350 sampled tracks (trending, underground, three searches):
  - no licence field: 248
  - "All rights reserved": 81
  - CC BY-SA: 13
  - CC BY-NC-SA: 5
  - CC BY-ND: 1
  - CC BY-NC: 1
  - **CC BY: 1**

**Final: Audius NOT SAFE, leave out.** The one exception that passes the rule is a CC BY-only mode. Because it reaches about 0.3% of tracks, I recommend **not building it**. If the owner chooses it anyway, follow §3.2 exactly.

### 2.2 Partner programmes (not "without permission", so leave out)

| Provider | Who integrates today | Where to apply | What they'd ask / blockers |
|---|---|---|---|
| Apple Music ("DJ with Apple Music") | djay (Feb 2024), rekordbox, Serato, Engine DJ, Denon DJ, Numark, RANE ([MacRumors](https://www.macrumors.com/2025/03/25/dj-with-apple-music/); [Algoriddim](https://community.algoriddim.com/t/announcement-apple-music-integration-with-djay/24279)) | No public application. Developer forum requests go unanswered ([843627](https://developer.apple.com/forums/thread/843627), [854096](https://developer.apple.com/forums/thread/854096)). Only route: Apple business development. | Contract. FairPlay DRM: public MusicKit doesn't expose PCM ([forum](https://developer.apple.com/forums/thread/825925)), and Web Audio can't process EME media ([W3C](https://lists.w3.org/Archives/Public/public-audio/2014JanMar/0031.html), [Mozilla 1331763](https://bugzilla.mozilla.org/show_bug.cgi?id=1331763)). |
| TIDAL (DJ Extension) | djay, Serato, rekordbox, Denon/Engine, DJUCED, edjing, DEX 3, VirtualDJ ([tidal djs](https://listen.tidal.com/djs); [support](https://support.tidal.com/hc/en-us/articles/27563493690129-DJ-Extension-Add-On)) | No public DJ form. Contact TIDAL partnerships ([partner pages](https://listen.tidal.com/partners/serato)). The public [developer.tidal.com](https://developer.tidal.com) platform uses PKCE, but playback runs only through the TIDAL Player SDK ([third-party profile](https://github.com/api-evangelist/tidal); [SDK](https://github.com/tidal-music/tidal-sdk); [previews only, #40](https://github.com/orgs/tidal-music/discussions/40)). | Contract, company entity, DRM. Whether open-source apps are eligible is unknown. |
| SoundCloud ("SoundCloud DJ") | VirtualDJ, Serato, rekordbox/WeDJ, djay; Traktor DJ 2 dropped ([help](https://help.soundcloud.com/hc/en-us/articles/48272877580443-Get-Started-With-SoundCloud-DJ)) | API keys by application and review ([blog](https://developers.soundcloud.com/blog/api-sign-up-changes)). DJ access by partner deal only. | The public terms forbid this use anyway: you "must not modify any User Content (including adaptation, editing…)", and Go+ content is off-limits ([policies](https://developers.soundcloud.com/policies); [terms](https://developers.soundcloud.com/docs/api/terms-of-use)). |
| Beatport Streaming (Beatsource merged in 2026) | rekordbox, Serato, Traktor, djay, VirtualDJ, Engine, DJ.Studio ([Digital DJ Tips](https://www.digitaldjtips.com/its-official-beatsource-is-merging-into-beatport/)) | Partner portal via business development; the v4 API is for approved partners only ([apis.io, third-party](https://apis.io/providers/beatport/)) | Contract. Users need an Advanced or Professional plan. |
| Spotify | rekordbox, Serato, djay: desktop since 24 Sep 2025, mobile since 11 Dec 2025, Premium only, 51 markets ([newsroom](https://newsroom.spotify.com/2025-09-24/dj-software-integration-premium)) | No public programme | Not realistic. |
| Amazon Music | none | "Closed Beta"; business-development representative ([docs](https://developer.amazon.com/docs/music/API_web_overview.html)) | Contract. |

### 2.3 Not allowed / NOT SAFE

- **YouTube / YouTube Music.**
  - The policy guide lists as non-compliant to "offer users the ability to download or separate audio tracks", and to download for offline play outside YouTube Premium ([guide](https://developers.google.com/youtube/terms/developer-policies-guide); [policies](https://developers.google.com/youtube/terms/developer-policies)).
  - There is no official Music API; `ytmusicapi` is "not supported nor endorsed by Google" ([docs](https://ytmusicapi.readthedocs.io/)).
  - Never mute the IFrame player and send its audio to the decks.
- **Spotify.**
  - Its compliance guidance lists "DJ/Mixes: Using Spotify's catalog to segue, mix, re-mix, or overlap any Spotify Content with any other audio content" ([quoted from developer.spotify.com/policy/complying](https://community.spotify.com/t5/Spotify-for-Developers/Question-regarding-no-mixing-policy/td-p/5282821)).
  - Extended access is for organisations only since 15 May 2025; Development Mode is capped at 5 users ([thread](https://community.spotify.com/t5/Spotify-for-Developers/February-2026-Spotify-for-Developers-update-thread/m-p/7368656/highlight/true)).
  - Playback is Widevine DRM.
- **Audius (default licence):** §2.1-C.
- **Jamendo.** "The API may be used freely for non-commercial uses. For any other type of use… contact… licensing@jamendo.com" ([terms](https://devportal.jamendo.com/api_terms_of_use)). DJ gigs are commercial.
- **Internet Archive:** rights vary per item and the licence metadata is uploader-supplied ([help](https://help.archive.org/help/search-a-basic-guide/)).
- **Free Music Archive:** API reportedly closed ([third-party](https://freedom251.com/apps/free-music-archive/)).
- **Bandcamp:** no API; scraping only.
- **Freesound:** samples only; out of scope.
- **Deezer:** API "disabled for the time being" ([community](https://en.deezercommunity.com/features-feedback-44/api-auth-impossible-80857)).

## 3. Plan

### 3.1 Recommended work (SAFE)

1. **Settings → Sources: an empty-state hint.**
   - "Want streaming? Run Navidrome (free) on your own music, or connect Jellyfin, Plex or Emby."
   - "Buy DRM-free files (Bandcamp, Beatport, Juno, Traxsource) and import them."
   - Effort: S.
2. **Short help page on why there's no Spotify / YouTube / Apple / TIDAL** (one paragraph each, linking to §2.2–2.3), so users stop asking.
3. **No changes** to `public/js/video/youtube.js` beyond a code comment that its audio must never be routed into the mixer.

### 3.2 Optional: Audius "CC BY only" mode (only if the owner explicitly wants it; not recommended)

**Architecture.**
- New file `public/js/shared/sources/audius.js` with `AudiusClient extends SourceClient`.
- Add optional `search(query)` and `browse(section)` methods to the base contract.
- `listTracks()` returns `[]`: never mirror the catalogue.
- Register the client in `index.js` with an optional user `token` field labelled "Audius API key". Add it to `USER_TOKEN_TYPES`.
- The stream goes through the existing paths: `server/remote.js:162`, and `public/js/local/sources.js:208` for web and mobile.

**Requirements, to implement exactly:**

| Area | Requirement |
|---|---|
| Filter | Show and play a track only if `license === 'Attribution CC BY'` **and** `is_streamable === true` **and** `is_stream_gated !== true` **and** `stream_conditions == null` **and** `access.stream === true` **and** it isn't deleted, unlisted or unavailable. Any other licence value, including null, "All rights reserved" and every other CC variant, is hidden. Re-check metadata immediately before each deck load. If the check fails, refuse to load. |
| Keys | Each user's own free API key (stored as `token`). Calls work keyless today with `app_name=OpenDJ` on every request. **Never** ship or ask for the API secret or bearer token. Any future Audius login uses OAuth PKCE only. |
| Rate limits | Client limiter at no more than 5 req/s (free plan is 10/s, 500k/month per key). Search debounced at 300 ms or more. Back off on HTTP 429. |
| Caching | **Session only** for everything: metadata, artwork, decoded audio, and analysis (BPM, beatgrid, waveform). Keep it in memory, never on disk, and clear it when the app session ends. Use Audius's own `bpm` and `musical_key` fields. Never persist the signed stream URLs. |
| Offline | Not allowed. Offline set prep excludes Audius tracks and says why. |
| Downloads | Not allowed. `downloadRequest` throws. No export or "save to library". |
| Attribution (UI) | On the library row, the deck header and now-playing: artist name, track title, "© [artist]" (from `copyright_line` if present), "CC BY 4.0" linked to https://creativecommons.org/licenses/by/4.0/, "via Audius · Open Music License" linked to the OML, and a link to the track permalink. If the artist asks, remove their identification (OML §1.5(e)). |
| Recording / broadcast | Allowed for CC BY tracks only if the exported tracklist or cue sheet (`recording-core.js`) includes, for each Audius track: artist, title, permalink, "CC BY 4.0" with link, and "modified (tempo/EQ/effects/mixed)". Show a one-time notice that the DJ must publish this tracklist alongside the recording or stream. |
| Live performance notice | One-time: "Public performance may also need local performing-rights licences (PRS, ASCAP and so on)." |
| Legal notices | Link the Audius Privacy Policy and API Terms in OpenDJ's About / Sources screen (an API Terms requirement). |
| Takedown | (1) Re-validate each track before every load. (2) A "Report track" item that opens Audius support and gives dmca@audius.co. (3) Fail closed: on 401, 403 or termination, hide Audius completely. (4) Respect `allowed_api_keys` and any artist setting changes immediately (API Terms). |
| Project acceptance | Using the API binds the project to the API Terms (indemnity, California arbitration, Audius may terminate or modify at will). The owner must accept this explicitly before shipping. |

## 4. Risks and remaining unverified items

Item 4.1 from the previous version is **resolved**: Audius is NOT SAFE (§2.1-C). What remains:
1. CORS and Range headers on Audius content nodes (`creatornode.audius.co`): **UNVERIFIED**, proxy blocked. This only matters if the CC BY mode is built.
2. Audius docs pages on docs.audius.org timed out. Key-handling guidance comes from [audius.co/agents.md](https://audius.co/agents.md) and the plans page instead.
3. Spotify's "DJ/Mixes" wording is confirmed only through forum quotes. The conclusion doesn't change.
4. YouTube policy text after the May 2026 revision was not re-read. The ban on separating audio is long-standing.
5. No public application routes were found for the Apple, TIDAL, Beatport or SoundCloud DJ programmes. Whether an MIT open-source app could join any of them is unknown.
6. Jamendo clause 4.1 (attribution) was not read. The verdict holds anyway because of the non-commercial clause.
7. The uploader-rights risk (mashups carrying CC licences) applies to any Audius use. OML §1.7 indemnity from anonymous uploaders is of limited practical value.

## 5. Verification log (2026-11-21)

| Step | Result |
|---|---|
| `curl https://audius.co/documents/ApiTerms.pdf` | 200, 6 pages, extracted with `pdftotext`, read in full |
| `curl https://audius.co/documents/TermsOfUse.pdf` | 200, 8 pages, extracted; relevant sections read (licence, Content License, CC options, API/OML, restrictions, DMCA) |
| `curl https://audius.org/open-music-license.pdf` | 301 → openaudiofoundation.org (proxy-blocked) |
| `curl raw.githubusercontent.com/AudiusProject/audius.org/main/public/open-music-license.pdf` | 200, the same OML (last updated 2 July 2025), read in full |
| `curl https://audius.co/agents.md` | 200; key guidance ("never expose [API Secret] on the frontend") |
| `curl https://api.audius.co/plans` (plus its JS bundle) | Free: 10 req/s, 500,000 req/month; PKCE redirect URIs; legacy secret-signing |
| `docs.audius.org`, `docs.audius.co` | Timed out (no response) |
| `GET /v1/tracks/trending?app_name=OpenDJ&limit=3` | 200, no key, `ACAO: *` |
| `GET /v1/tracks/V66vyPP/stream?app_name=OpenDJ` | 302 to a signed content-node URL, `ACAO: *`; OPTIONS 204 allows `range` |
| Content node `creatornode.audius.co` | Proxy-blocked: CORS and Range **UNVERIFIED** |
| Licence sample (350 tracks) | null 248, All rights reserved 81, BY-SA 13, BY-NC-SA 5, BY-ND 1, BY-NC 1, **BY 1** |
| Earlier provider research | Web search excerpts; developers.google.com, developer.spotify.com and devportal.jamendo.com couldn't be fetched directly |
