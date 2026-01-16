# s.....d.... puppy #7

Extracts hls playlist urls from some sites using JW Player bundle_jw.js and provider.hls.js and proxies playlist.



## Usage

**Extract playlist**

http://localhost:4000/get?url=some_embed_url&referer=some_site

**Proxy playlist**

http://localhost:3999/playlist?url=https%3A%2F%2Fcdn.example.com%2Fpath%2Findex.m3u8




## Installation

Run under node.js or inside docker container (recommended)

**Node**

To start services: `npm run all`

To test: `npm run test`

**Docker**

To build: `docker build -t sdpuppy7:1.x .`

To run: `docker run --init --restart=always --name sdpuppy7 -d -p 4000:4000 -p 3999:3999 sdpuppy7:1.x`

To change ports: `-e PORT=1235 -p 1235:1235 -e PROXY_PORT=1234 -p 1235:1234`
