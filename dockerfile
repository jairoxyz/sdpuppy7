# Use a slim debian image as the base image
FROM node:lts-slim

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG TARGETARCH
ARG PORT=4000
ARG PROXY_PORT=3999

RUN printf "I am running on ${BUILDPLATFORM}, building for ${TARGETPLATFORM}\n"

# Install necessary dependencies for running Chrome
RUN apt-get update && apt-get install -y \
    # dumb-init \
    bash \
    # curl \
    # ca-certificates \
    chromium \
    # chromium-driver \
    # xvfb \
    && rm -rf /var/lib/apt/lists/*

# RUN apt-get upgrade chromium

# ENV CHROME_BIN=/usr/bin/chromium
# ENV PUPPETEER_EXEC_PATH=/usr/bin/chromium
ENV PORT=${PORT}
ENV PROXY_PORT=${PROXY_PORT}

RUN npm i -g pm2

# make needed dirs
USER node
RUN mkdir -p /home/node/app
WORKDIR /home/node/app
RUN chown -R node:node /home/node/app

# Bundle app source and chown to non root
COPY --chown=node:node . .
RUN chmod +x /home/node/app/start.sh

# Install, build, and remove source code & dev packages
RUN npm install && \
    npm prune --production

# Expose app port binding
EXPOSE ${PORT} ${PROXY_PORT}

# ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# CMD [ "npm", "start" ]
# CMD ["pm2-runtime", "./index.js"]

# Start both apps via PM2 without an ecosystem file
CMD ["bash", "-lc", "./start.sh"]

