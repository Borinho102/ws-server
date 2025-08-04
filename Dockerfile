FROM node:20-alpine AS builder

WORKDIR /ws

# Copy package files
COPY src/ws/package*.json ./

# Use npm install instead of npm ci since we don't have package-lock.json
RUN npm install

# Copy source code
COPY src/ws .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /ws

# Copy package files
COPY src/ws/package*.json ./

# Use npm install for production dependencies
RUN npm install --omit=dev

# Copy built application from builder stage
COPY --from=builder /ws/dist ./dist

EXPOSE 4000

CMD ["npm", "start"]