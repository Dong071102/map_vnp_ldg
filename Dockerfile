FROM node:24-alpine

WORKDIR /app

# Install production backend dependencies only (mssql)
COPY package.json ./
COPY backend/package*.json ./backend/
RUN if [ -f backend/package-lock.json ]; then \
      npm --prefix backend ci --omit=dev; \
    else \
      npm --prefix backend install --omit=dev; \
    fi

# Copy application source & static open-data assets (.env excluded via .dockerignore)
COPY backend ./backend
COPY frontend ./frontend
COPY table.html ./table.html

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "backend/src/server.mjs"]
