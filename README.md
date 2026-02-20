# s.....d.... puppy #7

Extracts hls playlist urls from some sites using JW Player bundle_jw.js and provider.hls.js and proxies playlist.



## Usage

**Extract playlist**

http://localhost:3999/playlist?url=some_urlencoded_embed_url&referer=some_site&resolve_only=1

**Extract playlist matching some url path**

http://localhost:3999/playlist?url=some_urlencoded_embed_url&referer=some_site&resolve_only=1&m3u8_match=some_url_path

**Resolve and proxy playlist with optional session ttl in secs (default 120)**

http://localhost:3999/playlist?url=some_urlencoded_embed_url&referer=some_site&idle=secs




## Installation

Run under node.js or inside docker container (recommended)

**Node**

To start services: `npm run all`

To test: `npm run test`

**Docker**

To build: `docker build -t sdpuppy7:latest .`

To run: `docker run --init --restart=always --name sdpuppy7 -d -p 3999:3999 sdpuppy7:latest`

To change ports: `-e PROXY_PORT=1234 -p 1235:1234`
