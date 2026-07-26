FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the application files and build
COPY . .
# Build only needs a syntactically valid URL because runtime secrets are injected later.
ENV DATABASE_URL=postgres://roomio:roomio@localhost:5432/roomio
RUN npm run build

# Runner stage
FROM node:24-alpine AS runner

WORKDIR /app

# Copy built files, scripts, migrations, and node_modules from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Environment variables
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(3000)}).then(async(r)=>{await r.arrayBuffer();process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

# Start script runs migrations first, then boots the API.
CMD ["npm", "run", "start"]
