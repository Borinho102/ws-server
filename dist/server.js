"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const socket_io_1 = require("socket.io");
class SocketIOServer {
    constructor(port = 4000, corsOrigins = true) {
        this.port = parseInt(process.env.PORT || port.toString(), 10);
        this.server = (0, http_1.createServer)();
        this.io = new socket_io_1.Server(this.server, {
            cors: {
                origin: corsOrigins,
                methods: ['GET', 'POST'],
                credentials: true
            },
            path: '/socket.io/'
        });
        this.heartbeatInterval = null;
        this.setupMiddleware();
        this.setupEventHandlers();
        this.setupGracefulShutdown();
    }
    // Setup authentication middleware
    setupMiddleware() {
        this.io.use((socket, next) => {
            const token = socket.handshake.auth.token || socket.handshake.query.token;
            console.log('🔐 Auth token:', token);
            // Add your authentication logic here
            next();
        });
    }
    // Setup all event handlers
    setupEventHandlers() {
        this.io.on('connection', (socket) => {
            this.handleConnection(socket);
        });
    }
    // Handle new client connections
    handleConnection(socket) {
        const clientIP = socket.handshake.address;
        console.log('🔌 Client connected:', socket.id, 'from', clientIP);
        // Send welcome message
        this.sendWelcome(socket);
        // Register event handlers for this socket
        socket.on('message', (data) => this.handleMessage(socket, data));
        socket.on('chat', (data) => this.handleChat(socket, data));
        socket.on('private_message', (data) => this.handlePrivateMessage(socket, data));
        socket.on('join_room', (roomName) => this.handleJoinRoom(socket, roomName));
        socket.on('room_message', (data) => this.handleRoomMessage(socket, data));
        socket.on('typing_start', (data) => this.handleTypingStart(socket, data));
        socket.on('typing_stop', () => this.handleTypingStop(socket));
        socket.on('file_share', (data) => this.handleFileShare(socket, data));
        socket.on('disconnect', (reason) => this.handleDisconnect(socket, reason));
        socket.on('leave', () => this.handleLeave(socket));
        socket.on('error', (error) => this.handleError(socket, error));
    }
    // Send welcome message to newly connected client
    sendWelcome(socket) {
        socket.emit('welcome', {
            message: 'Connected to Socket.IO server',
            socketId: socket.id,
            timestamp: new Date().toISOString()
        });
    }
    // Handle regular messages with echo
    handleMessage(socket, data) {
        console.log('📨 Received message:', data);
        socket.emit('echo', {
            original: data,
            echo: `Echo: ${data.toString()}`,
            timestamp: new Date().toISOString()
        });
    }
    // Handle chat messages (broadcast to all)
    handleChat(socket, data) {
        console.log('💬 Chat message:', data);
        this.io.emit('chat', {
            ...data,
            socketId: socket.id,
            timestamp: new Date().toISOString()
        });
    }
    // Handle private messages between users
    handlePrivateMessage(socket, data) {
        const { targetSocketId, message } = data;
        console.log('🔒 Private message to:', targetSocketId);
        socket.to(targetSocketId).emit('private_message', {
            from: socket.id,
            message,
            timestamp: new Date().toISOString()
        });
    }
    // Handle room joining
    handleJoinRoom(socket, roomName) {
        socket.join(roomName);
        console.log(`🏠 Socket ${socket.id} joined room: ${roomName}`);
        // Notify existing room members
        socket.to(roomName).emit('user_joined', {
            socketId: socket.id,
            room: roomName,
            timestamp: new Date().toISOString()
        });
        // Confirm to user
        socket.emit('joined_room', { room: roomName });
    }
    // Handle room-specific messages
    handleRoomMessage(socket, data) {
        const { room, message } = data;
        console.log(`🏠 Room message in ${room}:`, message);
        this.io.to(room).emit('room_message', {
            from: socket.id,
            room,
            message,
            timestamp: new Date().toISOString()
        });
    }
    // Handle typing indicators
    handleTypingStart(socket, data) {
        socket.broadcast.emit('user_typing', {
            socketId: socket.id,
            ...data
        });
    }
    handleTypingStop(socket) {
        socket.broadcast.emit('user_stopped_typing', {
            socketId: socket.id
        });
    }
    // Handle file sharing
    handleFileShare(socket, data) {
        console.log('📎 File shared:', data.fileName);
        socket.broadcast.emit('file_received', {
            from: socket.id,
            ...data,
            timestamp: new Date().toISOString()
        });
    }
    // Handle client disconnection
    handleDisconnect(socket, reason) {
        console.log('❌ Client disconnected:', socket.id, 'Reason:', reason);
        socket.broadcast.emit('user_disconnected', {
            socketId: socket.id,
            reason,
            timestamp: new Date().toISOString()
        });
    }
    // Handle manual leave
    handleLeave(socket) {
        console.log('👋 Client leaving:', socket.id);
        socket.disconnect(true);
    }
    // Handle socket errors
    handleError(socket, error) {
        console.error('🚨 Socket error:', error);
    }
    // Public methods for external message sending
    // Send message to all connected clients
    broadcastMessage(eventName, data) {
        this.io.emit(eventName, {
            ...data,
            timestamp: new Date().toISOString()
        });
    }
    // Send message to specific socket
    sendToSocket(socketId, eventName, data) {
        this.io.to(socketId).emit(eventName, {
            ...data,
            timestamp: new Date().toISOString()
        });
    }
    // Send message to specific room
    sendToRoom(roomName, eventName, data) {
        this.io.to(roomName).emit(eventName, {
            ...data,
            timestamp: new Date().toISOString()
        });
    }
    // Send message to all clients except specific socket
    broadcastExcept(excludeSocketId, eventName, data) {
        this.io.except(excludeSocketId).emit(eventName, {
            ...data,
            timestamp: new Date().toISOString()
        });
    }
    // Get connected clients count
    getConnectedClientsCount() {
        return this.io.engine.clientsCount;
    }
    // Get all socket IDs in a room
    async getSocketsInRoom(roomName) {
        const sockets = await this.io.in(roomName).fetchSockets();
        return sockets.map((socket) => socket.id);
    }
    // Force disconnect a socket
    disconnectSocket(socketId, reason = 'server_disconnect') {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
            socket.disconnect(true);
            console.log(`🚪 Forcefully disconnected socket: ${socketId}, reason: ${reason}`);
        }
    }
    // Start heartbeat mechanism
    startHeartbeat(interval = 30000) {
        this.heartbeatInterval = setInterval(() => {
            this.io.emit('heartbeat', {
                timestamp: new Date().toISOString(),
                connectedClients: this.getConnectedClientsCount()
            });
        }, interval);
        console.log(`💓 Heartbeat started with ${interval}ms interval`);
    }
    // Stop heartbeat mechanism
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
            console.log('💓 Heartbeat stopped');
        }
    }
    // Setup graceful shutdown
    setupGracefulShutdown() {
        process.on('SIGTERM', () => {
            console.log('🛑 SIGTERM received, shutting down gracefully');
            this.shutdown();
        });
        process.on('SIGINT', () => {
            console.log('🛑 SIGINT received, shutting down gracefully');
            this.shutdown();
        });
    }
    // Graceful shutdown
    shutdown() {
        this.stopHeartbeat();
        this.io.close(() => {
            this.server.close(() => {
                console.log('✅ Server closed');
                process.exit(0);
            });
        });
    }
    // Start the server
    start() {
        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`✅ Socket.IO Server running at http://0.0.0.0:${this.port}`);
            console.log(`🔌 WebSocket endpoint: ws://0.0.0.0:${this.port}/socket.io/`);
            this.startHeartbeat();
        });
        return this;
    }
    // Stop the server
    stop() {
        this.shutdown();
    }
}
// Usage example:
exports.default = SocketIOServer;
// To use the class:
const socketServer = new SocketIOServer(4000); // Now allows all origins by default
// Or explicitly allow all origins:
// const socketServer = new SocketIOServer(4000, true);
// Or specify specific origins:
// const socketServer = new SocketIOServer(4000, ['http://localhost:3000', 'https://mydomain.com']);
socketServer.start();
// Send messages programmatically:
socketServer.broadcastMessage('announcement', { message: 'Server maintenance in 5 minutes' });
socketServer.sendToRoom('general', 'room_notification', { message: 'Welcome to the general room!' });
socketServer.sendToSocket('specific-socket-id', 'private_notification', { message: 'Hello there!' });
