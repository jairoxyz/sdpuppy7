#!/usr/bin/env bash
set -euo pipefail

# # Start both apps under PM2
# pm2 start ./index.js   --name resolver --time
# pm2 start ./hlsprxy.js --name hls-proxy --time

# # Save the current PM2 list
# pm2 save


# pm2 -v
# pm2 ls
# pm2 env 0 || true
# pm2 env 1 || true


# # Hand over to pm2-runtime for proper PID 1 supervision
# exec pm2-runtime --no-auto-exit


# echo "==> Starting apps with PM2…"
# pm2 start ./index.js   --name resolver --time ${PM2_WATCH:+--watch --ignore-watch "node_modules logs tmp .git"}
# pm2 start ./hlsprxy.js --name hls-proxy --time ${PM2_WATCH:+--watch --ignore-watch "node_modules logs tmp .git"}

# echo "==> Listing apps…"
# pm2 ls || true
# pm2 describe resolver || true
# pm2 describe hls-proxy || true

# echo "==> Showing last 50 lines of each log…"
# pm2 logs --lines 50 --raw & sleep 2 && pkill -f "pm2 logs" || true

# echo "==> Saving process list…"
# pm2 save || true

# echo "==> Handing over to pm2-runtime (foreground)…"
# exec pm2-runtime --no-auto-exit


# Ensure we’re in the right directory (optional if WORKDIR is set)
cd /home/node/app

# Generate an in-memory ecosystem for both services
cat >/tmp/ecosystem.json <<'JSON'
{
  "apps": [
    { "name": "resolver",  "script": "./index.js",   "exec_mode": "fork", "instances": 1 },
    { "name": "hls-proxy", "script": "./hlsprxy.js", "exec_mode": "fork", "instances": 1 }
  ]
}
JSON

# You can also inject env here if you want fixed ports:
#   "env": { "PORT": "4000" } and "env": { "PROXY_PORT": "3999" }
# Otherwise the container env is inherited.

exec pm2-runtime /tmp/ecosystem.json



