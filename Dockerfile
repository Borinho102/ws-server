FROM node:20-alpine

WORKDIR /ws

# Copy only ws-specific package.json and tsconfig
COPY src/ws/package*.json ./

RUN npm install

# Copy only the WebSocket server source code
COPY src/ws .

# Build only the /ws files
RUN npm run build

EXPOSE 4000

CMD ["npm", "start"]
