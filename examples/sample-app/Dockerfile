# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
ARG BUILD_LABEL=none
ENV NODE_ENV=production BUILD_LABEL=${BUILD_LABEL}
COPY server.js release.json ./
# Demonstrates consuming an optional BuildKit secret without storing it in a
# layer: only the secret's length is recorded, never its value.
RUN --mount=type=secret,id=SAMPLE_BUILD_SECRET \
    if [ -f /run/secrets/SAMPLE_BUILD_SECRET ]; then \
      echo "build secret present ($(wc -c < /run/secrets/SAMPLE_BUILD_SECRET) bytes)"; \
    else echo "no build secret provided"; fi
USER node
EXPOSE 3000
CMD ["node", "server.js"]
