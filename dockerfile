# Use a slim debian image as the base image
FROM node:lts-slim

ARG APP_VERSION="unspecified"
ARG VCS_REF="unspecified"
ARG BUILD_DATE="unspecified"
LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG TARGETARCH
# ARG PORT=4000
ARG PROXY_PORT=3999

RUN printf "I am running on ${BUILDPLATFORM}, building for ${TARGETPLATFORM}\n"

# Install necessary dependencies for running Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    xvfb \
    # chromium deps
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libgtk-3-0 \
    libdbus-1-3 \
    libcups2 \
    libexpat1 \
    libudev1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxi6 \
    libxkbcommon0 \
    libdrm2 \
    libgbm1 \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libfontconfig1 \
    libfreetype6 \
    libpng16-16 \
    libasound2 \
    fonts-liberation \
    fonts-noto-color-emoji fonts-freefont-ttf fonts-unifont \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf \
 && rm -rf /var/lib/apt/lists/*


# RUN npm i -g pm2

# make needed dirs
USER node
RUN mkdir -p /home/node/app
WORKDIR /home/node/app
RUN chown -R node:node /home/node/app

ENV HOME=/home/node \
    DISPLAY=:99 \
    NODE_ENV=production \
    PROXY_PORT=${PROXY_PORT} \
    CLOAKBROWSER_CACHE_DIR=/home/node/.cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false

# Bundle app source and chown to non root
COPY --chown=node:node . .
# RUN chmod +x /home/node/app/start.sh

# Install, build, and remove source code & dev packages
RUN npm install && \
    npm prune --production

# Expose app port binding
# EXPOSE ${PORT} ${PROXY_PORT}
EXPOSE ${PROXY_PORT}

# ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD [ "node", "./plres_hlsprxy.js" ]
# CMD ["pm2-runtime", "./plres_hlsprxy.js"]


