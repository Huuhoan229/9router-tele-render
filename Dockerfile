FROM decolua/9router:latest

USER root

# Ensure both /app/data and ~/.9router point to the exact same directory
RUN mkdir -p /app/data /home/node && \
    rm -rf /home/node/.9router && \
    ln -s /app/data /home/node/.9router && \
    chown -R node:node /app/data /home/node

# Copy runner scripts and install Zalo Personal Bot library (zca-js)
COPY --chown=node:node runner/package.json /app/runner/package.json
RUN cd /app/runner && npm install --omit=dev --no-audit --no-fund && chown -R node:node /app/runner

COPY --chown=node:node runner/ /app/runner/

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=20128 \
    DATA_DIR=/app/data

EXPOSE 20128

# Base image /entrypoint.sh fixes permissions on /app/data and runs CMD as `node`
CMD ["node", "--dns-result-order=ipv4first", "--max-old-space-size=128", "/app/runner/start.js"]
