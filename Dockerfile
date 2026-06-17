FROM node:26-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the application files and build
COPY . .
RUN npm run build

# Runner stage
FROM node:26-alpine AS runner

WORKDIR /app

# Copy built files, scripts, migrations, and node_modules from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Environment variables
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# Run migrations and start the SvelteKit application directly
CMD ["sh", "-c", "npm run db:migrate && node build/index.js"]
