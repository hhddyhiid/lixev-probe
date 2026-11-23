FROM node:24-alpine

# Security: refresh the Alpine packages the official image ships with, then drop
# npm / corepack / yarn entirely — this node has zero JS dependencies and never uses them.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /opt/yarn-v1* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY server.js /app/server.js

ENV PORT=8080
EXPOSE 8080

# zero-dependency VLESS-over-WS + komari agent supervisor, one process tree.
# VLESS_UUID and KA_TOKEN are supplied as environment variables.
CMD ["node", "/app/server.js"]
