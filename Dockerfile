FROM node:20-alpine

WORKDIR /app
COPY server.js /app/server.js

ENV PORT=8080
EXPOSE 8080

# zero-dependency VLESS-over-WS + komari agent supervisor, single process tree
CMD ["node", "/app/server.js"]
