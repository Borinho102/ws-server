import { createServer, Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

interface MessageData {
  [key: string]: any;
}

interface ChatData {
  message: string;
  user?: string;
  room?: string;
  [key: string]: any;
}

interface PrivateMessageData {
  targetSocketId: string;
  message: string;
}

interface RoomMessageData {
  room: string;
  message: string;
}

interface FileShareData {
  fileName: string;
  fileData: any;
  fileSize?: number;
  [key: string]: any;
}

interface TypingData {
  room?: string;
  [key: string]: any;
}

// Interface for user info (make sure this matches your client-side interface)
interface UserInfo {
  socketId: string;
  username?: string;
  status: 'online' | 'offline' | 'away' | 'busy';
  lastSeen: string;
  avatar?: string;
  customStatus?: string;
}

class SocketIOServer {
  private port: number;
  private server: HttpServer;
  private io: Server;
  private heartbeatInterval: NodeJS.Timeout | null;
  private onlineUsers: Map<string, UserInfo> = new Map(); // FIX: Make it instance property

  constructor(port: number = 4000, corsOrigins: string[] | string | boolean = true) {
    this.port = parseInt(process.env.PORT || port.toString(), 10);
    this.server = createServer();
    this.io = new Server(this.server, {
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
  private setupMiddleware(): void {
    this.io.use((socket: Socket, next: (err?: Error) => void) => {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      console.log('🔐 Auth token:', token);
      // Add your authentication logic here
      next();
    });
  }

  // Setup all event handlers
  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      this.handleConnection(socket);
    });
  }

  // Handle new client connections
  private handleConnection(socket: Socket): void {
    const clientIP = socket.handshake.address;
    console.log('🔌 Client connected:', socket.id, 'from', clientIP);

    // Send welcome message
    this.sendWelcome(socket);

    const userInfo: UserInfo = {
      socketId: socket.id,
      username: socket.handshake.auth?.username || `User ${socket.id.slice(0, 6)}`,
      status: 'online',
      lastSeen: new Date().toISOString(),
      avatar: socket.handshake.auth?.userInfo?.avatar,
      customStatus: socket.handshake.auth?.userInfo?.customStatus
    };

    // Add user to online users map
    this.onlineUsers.set(socket.id, userInfo); // FIX: Use this.onlineUsers
    console.log('👤 User added to online list:', userInfo.username, '- Total online:', this.onlineUsers.size);

    // Send current user list to the newly connected client
    socket.emit('user_list', {
      users: Array.from(this.onlineUsers.values())
    });

    // Broadcast to all OTHER clients that a new user joined
    socket.broadcast.emit('user_status_changed', {
      socketId: socket.id,
      status: 'online',
      customStatus: userInfo.customStatus,
      timestamp: userInfo.lastSeen
    });

    // Broadcast updated user list to all clients
    this.io.emit('user_list', {
      users: Array.from(this.onlineUsers.values())
    });

    // Register event handlers for this socket
    socket.on('message', (data: MessageData) => this.handleMessage(socket, data));
    socket.on('chat', (data: ChatData) => this.handleChat(socket, data));
    socket.on('private_message', (data: PrivateMessageData) => this.handlePrivateMessage(socket, data));
    socket.on('join_room', (roomName: string) => this.handleJoinRoom(socket, roomName));
    socket.on('room_message', (data: RoomMessageData) => this.handleRoomMessage(socket, data));
    socket.on('typing_start', (data: TypingData) => this.handleTypingStart(socket, data));
    socket.on('typing_stop', () => this.handleTypingStop(socket));
    socket.on('file_share', (data: FileShareData) => this.handleFileShare(socket, data));

    // FIX: Add proper status update handler with logging
    socket.on('status_update', (data: { status: 'online' | 'away' | 'busy', customStatus?: string }) => {
      console.log('📱 Received status_update from', socket.id, ':', data);
      this.handleStatusUpdate(socket, data);
    });

    socket.on('user_info_update', (data: Partial<UserInfo>) => this.handleUserInfoUpdate(socket, data));
    socket.on('get_user_list', () => this.handleGetUserList(socket));

    socket.on('disconnect', (reason: string) => this.handleDisconnect(socket, reason));
    socket.on('leave', () => this.handleLeave(socket));
    socket.on('error', (error: Error) => this.handleError(socket, error));
  }

  // Send welcome message to newly connected client
  private sendWelcome(socket: Socket): void {
    socket.emit('welcome', {
      message: 'Connected to Socket.IO server',
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });
  }

  // Handle regular messages with echo
  private handleMessage(socket: Socket, data: MessageData): void {
    console.log('📨 Received message:', data);

    socket.emit('echo', {
      original: data,
      echo: `Echo: ${data.toString()}`,
      timestamp: new Date().toISOString()
    });
  }

  // Handle chat messages (broadcast to all)
  private handleChat(socket: Socket, data: ChatData): void {
    console.log('💬 Chat message:', data);

    this.io.emit('chat', {
      ...data,
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });
  }

  // Handle private messages between users
  private handlePrivateMessage(socket: Socket, data: PrivateMessageData): void {
    const { targetSocketId, message } = data;
    console.log('🔒 Private message to:', targetSocketId);

    socket.to(targetSocketId).emit('private_message', {
      from: socket.id,
      message,
      timestamp: new Date().toISOString()
    });
  }

  // Handle room joining
  private handleJoinRoom(socket: Socket, roomName: string): void {
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
  private handleRoomMessage(socket: Socket, data: RoomMessageData): void {
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
  private handleTypingStart(socket: Socket, data: TypingData): void {
    socket.broadcast.emit('user_typing', {
      socketId: socket.id,
      ...data
    });
  }

  private handleTypingStop(socket: Socket): void {
    socket.broadcast.emit('user_stopped_typing', {
      socketId: socket.id
    });
  }

  // Handle file sharing
  private handleFileShare(socket: Socket, data: FileShareData): void {
    console.log('📎 File shared:', data.fileName);

    socket.broadcast.emit('file_received', {
      from: socket.id,
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // FIX: Proper status update handler
  private handleStatusUpdate(socket: Socket, data: { status: 'online' | 'away' | 'busy', customStatus?: string }): void {
    console.log('🔄 Processing status update for', socket.id, ':', data);

    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    if (!user) {
      console.warn('⚠️ User not found in online users:', socket.id);
      return;
    }

    console.log('👤 Current user:', user);

    // Update user status
    const updatedUser: UserInfo = {
      ...user,
      status: data.status,
      customStatus: data.customStatus || user.customStatus,
      lastSeen: new Date().toISOString()
    };

    this.onlineUsers.set(socket.id, updatedUser); // FIX: Use this.onlineUsers
    console.log('✅ User status updated:', updatedUser.username, 'to', data.status);

    // Broadcast status change to all clients
    this.io.emit('user_status_changed', {
      socketId: socket.id,
      status: data.status,
      customStatus: data.customStatus,
      timestamp: updatedUser.lastSeen
    });

    // Send updated user list
    this.io.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });

    console.log('📤 Status update broadcasted to all clients');
  }

  private handleUserInfoUpdate(socket: Socket, data: Partial<UserInfo>): void {
    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    if (!user) return;

    // Update user info (but preserve critical fields)
    const updatedUser: UserInfo = {
      ...user,
      ...data,
      socketId: socket.id, // Always preserve socket ID
      lastSeen: new Date().toISOString()
    };

    this.onlineUsers.set(socket.id, updatedUser); // FIX: Use this.onlineUsers
    console.log('👤 User info updated:', updatedUser.username);

    // Broadcast updated user list
    this.io.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });
  }

  private handleGetUserList(socket: Socket): void {
    console.log('📋 User list requested by:', socket.id);
    socket.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });
  }

  // FIX: Updated handleDisconnect method (remove duplicate)
  private handleDisconnect(socket: Socket, reason: string): void {
    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    const username = user?.username || socket.id;

    console.log('❌ Client disconnected:', socket.id, 'from', socket.handshake.address, 'reason:', reason);

    // Remove user from online users
    this.onlineUsers.delete(socket.id); // FIX: Use this.onlineUsers
    console.log('👤 User removed from online list:', username, '- Total online:', this.onlineUsers.size);

    // Broadcast user disconnection to all remaining clients
    socket.broadcast.emit('user_disconnected', {
      socketId: socket.id,
      reason: reason,
      timestamp: new Date().toISOString()
    });

    // Send updated user list to all remaining clients
    socket.broadcast.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });

    // Clean up any rooms the user was in
    this.cleanupUserFromRooms(socket);
  }

  // FIX: Updated handleLeave method
  private handleLeave(socket: Socket): void {
    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    const username = user?.username || socket.id;

    console.log('👋 Client leaving:', username);

    // Remove user from online users
    this.onlineUsers.delete(socket.id); // FIX: Use this.onlineUsers

    // Broadcast user leaving to all other clients
    socket.broadcast.emit('user_disconnected', {
      socketId: socket.id,
      reason: 'user_initiated',
      timestamp: new Date().toISOString()
    });

    // Send updated user list
    socket.broadcast.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });

    // Clean up and disconnect
    this.cleanupUserFromRooms(socket);
    socket.disconnect(true);
  }

  // Helper method to clean up user from rooms
  private cleanupUserFromRooms(socket: Socket): void {
    // Get all rooms the socket was in
    const rooms = Array.from(socket.rooms);

    rooms.forEach(room => {
      if (room !== socket.id) { // Skip the default room (socket's own ID)
        socket.leave(room);

        // Notify others in the room that user left
        socket.to(room).emit('user_left_room', {
          socketId: socket.id,
          room: room,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  // Add a method to get online user count for heartbeat
  private getOnlineUserCount(): number {
    return this.onlineUsers.size; // FIX: Use this.onlineUsers
  }

  // FIX: Updated heartbeat method to use correct user count
  private sendHeartbeat(): void {
    const heartbeatData = {
      timestamp: new Date().toISOString(),
      connectedClients: this.getOnlineUserCount() // Use actual online users count
    };

    this.io.emit('heartbeat', heartbeatData);
    console.log('💓 Heartbeat sent to', this.getOnlineUserCount(), 'clients');
  }

  // Handle socket errors
  private handleError(socket: Socket, error: Error): void {
    console.error('🚨 Socket error:', error);
  }

  // Debug method to check online users state
  private debugOnlineUsers(): void {
    console.log('🐛 DEBUG: Current online users:');
    this.onlineUsers.forEach((user, socketId) => {
      console.log(`  - ${socketId}: ${user.username} (${user.status})`);
    });
    console.log(`🐛 Total: ${this.onlineUsers.size} users`);
  }

  // Public methods for external message sending

  // Send message to all connected clients
  public broadcastMessage(eventName: string, data: MessageData): void {
    this.io.emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Send message to specific socket
  public sendToSocket(socketId: string, eventName: string, data: MessageData): void {
    this.io.to(socketId).emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Send message to specific room
  public sendToRoom(roomName: string, eventName: string, data: MessageData): void {
    this.io.to(roomName).emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Send message to all clients except specific socket
  public broadcastExcept(excludeSocketId: string, eventName: string, data: MessageData): void {
    this.io.except(excludeSocketId).emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Get connected clients count
  public getConnectedClientsCount(): number {
    return this.io.engine.clientsCount;
  }

  // Get all socket IDs in a room
  public async getSocketsInRoom(roomName: string): Promise<string[]> {
    const sockets = await this.io.in(roomName).fetchSockets();
    return sockets.map((socket) => socket.id);
  }

  // Force disconnect a socket
  public disconnectSocket(socketId: string, reason: string = 'server_disconnect'): void {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.disconnect(true);
      console.log(`🚪 Forcefully disconnected socket: ${socketId}, reason: ${reason}`);
    }
  }

  // Start heartbeat mechanism
  public startHeartbeat(interval: number = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat(); // FIX: Use the corrected sendHeartbeat method
    }, interval);
    console.log(`💓 Heartbeat started with ${interval}ms interval`);
  }

  // Stop heartbeat mechanism
  public stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('💓 Heartbeat stopped');
    }
  }

  // Setup graceful shutdown
  private setupGracefulShutdown(): void {
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
  public shutdown(): void {
    this.stopHeartbeat();

    this.io.close(() => {
      this.server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });
  }

  // Start the server
  public start(hostname = '0.0.0.0'): SocketIOServer {
    this.server.listen(this.port, hostname, () => {
      console.log(`✅ Socket.IO Server running at http://${hostname}:${this.port}`);
      console.log(`🔌 WebSocket endpoint: ws://${hostname}:${this.port}/socket.io/`);
      this.startHeartbeat();
    });

    return this;
  }

  // Stop the server
  public stop(): void {
    this.shutdown();
  }

  // Public method to get online users (for debugging)
  public getOnlineUsers(): UserInfo[] {
    return Array.from(this.onlineUsers.values());
  }

  // Public method to debug user state
  public debugUsers(): void {
    this.debugOnlineUsers();
  }
}

// Usage example:
export default SocketIOServer;

// To use the class:
const socketServer = new SocketIOServer(4000);

socketServer.start();

// Send messages programmatically:
socketServer.broadcastMessage('announcement', { message: 'Server maintenance in 5 minutes' });
socketServer.sendToRoom('general', 'room_notification', { message: 'Welcome to the general room!' });
socketServer.sendToSocket('specific-socket-id', 'private_notification', { message: 'Hello there!' });import { createServer, Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

interface MessageData {
  [key: string]: any;
}

interface ChatData {
  message: string;
  user?: string;
  room?: string;
  [key: string]: any;
}

interface PrivateMessageData {
  targetSocketId: string;
  message: string;
}

interface RoomMessageData {
  room: string;
  message: string;
}

interface FileShareData {
  fileName: string;
  fileData: any;
  fileSize?: number;
  [key: string]: any;
}

interface TypingData {
  room?: string;
  [key: string]: any;
}

// Interface for user info (make sure this matches your client-side interface)
interface UserInfo {
  socketId: string;
  username?: string;
  status: 'online' | 'offline' | 'away' | 'busy';
  lastSeen: string;
  avatar?: string;
  customStatus?: string;
}

class SocketIOServer {
  private port: number;
  private server: HttpServer;
  private io: Server;
  private heartbeatInterval: NodeJS.Timeout | null;
  private onlineUsers: Map<string, UserInfo> = new Map(); // FIX: Make it instance property

  constructor(port: number = 4000, corsOrigins: string[] | string | boolean = true) {
    this.port = parseInt(process.env.PORT || port.toString(), 10);
    this.server = createServer();
    this.io = new Server(this.server, {
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
  private setupMiddleware(): void {
    this.io.use((socket: Socket, next: (err?: Error) => void) => {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      console.log('🔐 Auth token:', token);
      // Add your authentication logic here
      next();
    });
  }

  // Setup all event handlers
  private setupEventHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      this.handleConnection(socket);
    });
  }

  // Handle new client connections
  private handleConnection(socket: Socket): void {
    const clientIP = socket.handshake.address;
    console.log('🔌 Client connected:', socket.id, 'from', clientIP);

    // Send welcome message
    this.sendWelcome(socket);

    const userInfo: UserInfo = {
      socketId: socket.id,
      username: socket.handshake.auth?.username || `User ${socket.id.slice(0, 6)}`,
      status: 'online',
      lastSeen: new Date().toISOString(),
      avatar: socket.handshake.auth?.userInfo?.avatar,
      customStatus: socket.handshake.auth?.userInfo?.customStatus
    };

    // Add user to online users map
    this.onlineUsers.set(socket.id, userInfo); // FIX: Use this.onlineUsers
    console.log('👤 User added to online list:', userInfo.username, '- Total online:', this.onlineUsers.size);

    // Send current user list to the newly connected client
    socket.emit('user_list', {
      users: Array.from(this.onlineUsers.values())
    });

    // Broadcast to all OTHER clients that a new user joined
    socket.broadcast.emit('user_status_changed', {
      socketId: socket.id,
      status: 'online',
      customStatus: userInfo.customStatus,
      timestamp: userInfo.lastSeen
    });

    // Broadcast updated user list to all clients
    this.io.emit('user_list', {
      users: Array.from(this.onlineUsers.values())
    });

    // Register event handlers for this socket
    socket.on('message', (data: MessageData) => this.handleMessage(socket, data));
    socket.on('chat', (data: ChatData) => this.handleChat(socket, data));
    socket.on('private_message', (data: PrivateMessageData) => this.handlePrivateMessage(socket, data));
    socket.on('join_room', (roomName: string) => this.handleJoinRoom(socket, roomName));
    socket.on('room_message', (data: RoomMessageData) => this.handleRoomMessage(socket, data));
    socket.on('typing_start', (data: TypingData) => this.handleTypingStart(socket, data));
    socket.on('typing_stop', () => this.handleTypingStop(socket));
    socket.on('file_share', (data: FileShareData) => this.handleFileShare(socket, data));

    // FIX: Add proper status update handler with logging
    socket.on('status_update', (data: { status: 'online' | 'away' | 'busy', customStatus?: string }) => {
      console.log('📱 Received status_update from', socket.id, ':', data);
      this.handleStatusUpdate(socket, data);
    });

    socket.on('user_info_update', (data: Partial<UserInfo>) => this.handleUserInfoUpdate(socket, data));
    socket.on('get_user_list', () => this.handleGetUserList(socket));

    socket.on('disconnect', (reason: string) => this.handleDisconnect(socket, reason));
    socket.on('leave', () => this.handleLeave(socket));
    socket.on('error', (error: Error) => this.handleError(socket, error));
  }

  // Send welcome message to newly connected client
  private sendWelcome(socket: Socket): void {
    socket.emit('welcome', {
      message: 'Connected to Socket.IO server',
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });
  }

  // Handle regular messages with echo
  private handleMessage(socket: Socket, data: MessageData): void {
    console.log('📨 Received message:', data);

    socket.emit('echo', {
      original: data,
      echo: `Echo: ${data.toString()}`,
      timestamp: new Date().toISOString()
    });
  }

  // Handle chat messages (broadcast to all)
  private handleChat(socket: Socket, data: ChatData): void {
    console.log('💬 Chat message:', data);

    this.io.emit('chat', {
      ...data,
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });
  }

  // Handle private messages between users
  private handlePrivateMessage(socket: Socket, data: PrivateMessageData): void {
    const { targetSocketId, message } = data;
    console.log('🔒 Private message to:', targetSocketId);

    socket.to(targetSocketId).emit('private_message', {
      from: socket.id,
      message,
      timestamp: new Date().toISOString()
    });
  }

  // Handle room joining
  private handleJoinRoom(socket: Socket, roomName: string): void {
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
  private handleRoomMessage(socket: Socket, data: RoomMessageData): void {
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
  private handleTypingStart(socket: Socket, data: TypingData): void {
    socket.broadcast.emit('user_typing', {
      socketId: socket.id,
      ...data
    });
  }

  private handleTypingStop(socket: Socket): void {
    socket.broadcast.emit('user_stopped_typing', {
      socketId: socket.id
    });
  }

  // Handle file sharing
  private handleFileShare(socket: Socket, data: FileShareData): void {
    console.log('📎 File shared:', data.fileName);

    socket.broadcast.emit('file_received', {
      from: socket.id,
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // FIX: Proper status update handler
  private handleStatusUpdate(socket: Socket, data: { status: 'online' | 'away' | 'busy', customStatus?: string }): void {
    console.log('🔄 Processing status update for', socket.id, ':', data);

    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    if (!user) {
      console.warn('⚠️ User not found in online users:', socket.id);
      return;
    }

    console.log('👤 Current user:', user);

    // Update user status
    const updatedUser: UserInfo = {
      ...user,
      status: data.status,
      customStatus: data.customStatus || user.customStatus,
      lastSeen: new Date().toISOString()
    };

    this.onlineUsers.set(socket.id, updatedUser); // FIX: Use this.onlineUsers
    console.log('✅ User status updated:', updatedUser.username, 'to', data.status);

    // Broadcast status change to all clients
    this.io.emit('user_status_changed', {
      socketId: socket.id,
      status: data.status,
      customStatus: data.customStatus,
      timestamp: updatedUser.lastSeen
    });

    // Send updated user list
    this.io.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });

    console.log('📤 Status update broadcasted to all clients');
  }

  private handleUserInfoUpdate(socket: Socket, data: Partial<UserInfo>): void {
    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    if (!user) return;

    // Update user info (but preserve critical fields)
    const updatedUser: UserInfo = {
      ...user,
      ...data,
      socketId: socket.id, // Always preserve socket ID
      lastSeen: new Date().toISOString()
    };

    this.onlineUsers.set(socket.id, updatedUser); // FIX: Use this.onlineUsers
    console.log('👤 User info updated:', updatedUser.username);

    // Broadcast updated user list
    this.io.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });
  }

  private handleGetUserList(socket: Socket): void {
    console.log('📋 User list requested by:', socket.id);
    socket.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });
  }

  // FIX: Updated handleDisconnect method (remove duplicate)
  private handleDisconnect(socket: Socket, reason: string): void {
    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    const username = user?.username || socket.id;

    console.log('❌ Client disconnected:', socket.id, 'from', socket.handshake.address, 'reason:', reason);

    // Remove user from online users
    this.onlineUsers.delete(socket.id); // FIX: Use this.onlineUsers
    console.log('👤 User removed from online list:', username, '- Total online:', this.onlineUsers.size);

    // Broadcast user disconnection to all remaining clients
    socket.broadcast.emit('user_disconnected', {
      socketId: socket.id,
      reason: reason,
      timestamp: new Date().toISOString()
    });

    // Send updated user list to all remaining clients
    socket.broadcast.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });

    // Clean up any rooms the user was in
    this.cleanupUserFromRooms(socket);
  }

  // FIX: Updated handleLeave method
  private handleLeave(socket: Socket): void {
    const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
    const username = user?.username || socket.id;

    console.log('👋 Client leaving:', username);

    // Remove user from online users
    this.onlineUsers.delete(socket.id); // FIX: Use this.onlineUsers

    // Broadcast user leaving to all other clients
    socket.broadcast.emit('user_disconnected', {
      socketId: socket.id,
      reason: 'user_initiated',
      timestamp: new Date().toISOString()
    });

    // Send updated user list
    socket.broadcast.emit('user_list', {
      users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
    });

    // Clean up and disconnect
    this.cleanupUserFromRooms(socket);
    socket.disconnect(true);
  }

  // Helper method to clean up user from rooms
  private cleanupUserFromRooms(socket: Socket): void {
    // Get all rooms the socket was in
    const rooms = Array.from(socket.rooms);

    rooms.forEach(room => {
      if (room !== socket.id) { // Skip the default room (socket's own ID)
        socket.leave(room);

        // Notify others in the room that user left
        socket.to(room).emit('user_left_room', {
          socketId: socket.id,
          room: room,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  // Add a method to get online user count for heartbeat
  private getOnlineUserCount(): number {
    return this.onlineUsers.size; // FIX: Use this.onlineUsers
  }

  // FIX: Updated heartbeat method to use correct user count
  private sendHeartbeat(): void {
    const heartbeatData = {
      timestamp: new Date().toISOString(),
      connectedClients: this.getOnlineUserCount() // Use actual online users count
    };

    this.io.emit('heartbeat', heartbeatData);
    console.log('💓 Heartbeat sent to', this.getOnlineUserCount(), 'clients');
  }

  // Handle socket errors
  private handleError(socket: Socket, error: Error): void {
    console.error('🚨 Socket error:', error);
  }

  // Debug method to check online users state
  private debugOnlineUsers(): void {
    console.log('🐛 DEBUG: Current online users:');
    this.onlineUsers.forEach((user, socketId) => {
      console.log(`  - ${socketId}: ${user.username} (${user.status})`);
    });
    console.log(`🐛 Total: ${this.onlineUsers.size} users`);
  }

  // Public methods for external message sending

  // Send message to all connected clients
  public broadcastMessage(eventName: string, data: MessageData): void {
    this.io.emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Send message to specific socket
  public sendToSocket(socketId: string, eventName: string, data: MessageData): void {
    this.io.to(socketId).emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Send message to specific room
  public sendToRoom(roomName: string, eventName: string, data: MessageData): void {
    this.io.to(roomName).emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Send message to all clients except specific socket
  public broadcastExcept(excludeSocketId: string, eventName: string, data: MessageData): void {
    this.io.except(excludeSocketId).emit(eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Get connected clients count
  public getConnectedClientsCount(): number {
    return this.io.engine.clientsCount;
  }

  // Get all socket IDs in a room
  public async getSocketsInRoom(roomName: string): Promise<string[]> {
    const sockets = await this.io.in(roomName).fetchSockets();
    return sockets.map((socket) => socket.id);
  }

  // Force disconnect a socket
  public disconnectSocket(socketId: string, reason: string = 'server_disconnect'): void {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.disconnect(true);
      console.log(`🚪 Forcefully disconnected socket: ${socketId}, reason: ${reason}`);
    }
  }

  // Start heartbeat mechanism
  public startHeartbeat(interval: number = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat(); // FIX: Use the corrected sendHeartbeat method
    }, interval);
    console.log(`💓 Heartbeat started with ${interval}ms interval`);
  }

  // Stop heartbeat mechanism
  public stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('💓 Heartbeat stopped');
    }
  }

  // Setup graceful shutdown
  private setupGracefulShutdown(): void {
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
  public shutdown(): void {
    this.stopHeartbeat();

    this.io.close(() => {
      this.server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });
  }

  // Start the server
  public start(hostname = '0.0.0.0'): SocketIOServer {
    this.server.listen(this.port, hostname, () => {
      console.log(`✅ Socket.IO Server running at http://${hostname}:${this.port}`);
      console.log(`🔌 WebSocket endpoint: ws://${hostname}:${this.port}/socket.io/`);
      this.startHeartbeat();
    });

    return this;
  }

  // Stop the server
  public stop(): void {
    this.shutdown();
  }

  // Public method to get online users (for debugging)
  public getOnlineUsers(): UserInfo[] {
    return Array.from(this.onlineUsers.values());
  }

  // Public method to debug user state
  public debugUsers(): void {
    this.debugOnlineUsers();
  }
}

// Usage example:
export default SocketIOServer;

// To use the class:
const socketServer = new SocketIOServer(4000);
socketServer.start();

// Send messages programmatically:
socketServer.broadcastMessage('announcement', { message: 'Server maintenance in 5 minutes' });
socketServer.sendToRoom('general', 'room_notification', { message: 'Welcome to the general room!' });
socketServer.sendToSocket('specific-socket-id', 'private_notification', { message: 'Hello there!' });
























// import { createServer, Server as HttpServer } from 'http';
// import { Server, Socket } from 'socket.io';
//
// interface MessageData {
//   [key: string]: any;
// }
//
// interface ChatData {
//   message: string;
//   user?: string;
//   room?: string;
//   [key: string]: any;
// }
//
// interface PrivateMessageData {
//   targetSocketId: string;
//   message: string;
// }
//
// interface RoomMessageData {
//   room: string;
//   message: string;
// }
//
// interface FileShareData {
//   fileName: string;
//   fileData: any;
//   fileSize?: number;
//   [key: string]: any;
// }
//
// interface TypingData {
//   room?: string;
//   [key: string]: any;
// }
//
// var onlineUsers: Map<string, UserInfo> = new Map();
//
// // Interface for user info (make sure this matches your client-side interface)
// interface UserInfo {
//   socketId: string;
//   username?: string;
//   status: 'online' | 'offline' | 'away' | 'busy';
//   lastSeen: string;
//   avatar?: string;
//   customStatus?: string;
// }
//
//
// class SocketIOServer {
//   private port: number;
//   private server: HttpServer;
//   private io: Server;
//   private heartbeatInterval: NodeJS.Timeout | null;
//
//   constructor(port: number = 4000, corsOrigins: string[] | string | boolean = true) {
//     this.port = parseInt(process.env.PORT || port.toString(), 10);
//     this.server = createServer();
//     this.io = new Server(this.server, {
//       cors: {
//         origin: corsOrigins,
//         methods: ['GET', 'POST'],
//         credentials: true
//       },
//       path: '/socket.io/'
//     });
//
//     this.heartbeatInterval = null;
//     this.setupMiddleware();
//     this.setupEventHandlers();
//     this.setupGracefulShutdown();
//   }
//
//   // Setup authentication middleware
//   private setupMiddleware(): void {
//     this.io.use((socket: Socket, next: (err?: Error) => void) => {
//       const token = socket.handshake.auth.token || socket.handshake.query.token;
//       console.log('🔐 Auth token:', token);
//       // Add your authentication logic here
//       next();
//     });
//   }
//
//   // Setup all event handlers
//   private setupEventHandlers(): void {
//     this.io.on('connection', (socket: Socket) => {
//       this.handleConnection(socket);
//     });
//   }
//
//   // Handle new client connections
//   private handleConnection(socket: Socket): void {
//     const clientIP = socket.handshake.address;
//     console.log('🔌 Client connected:', socket.id, 'from', clientIP);
//
//     // Send welcome message
//     this.sendWelcome(socket);
//
//     const userInfo: UserInfo = {
//       socketId: socket.id,
//       username: socket.handshake.auth?.username || `User ${socket.id.slice(0, 6)}`,
//       status: 'online',
//       lastSeen: new Date().toISOString(),
//       avatar: socket.handshake.auth?.userInfo?.avatar,
//       customStatus: socket.handshake.auth?.userInfo?.customStatus
//     };
//
//     // Add user to online users map
//     onlineUsers.set(socket.id, userInfo);
//     console.log('👤 User added to online list:', userInfo.username, '- Total online:', onlineUsers.size);
//
//     // Send current user list to the newly connected client
//     socket.emit('user_list', {
//       users: Array.from(onlineUsers.values())
//     });
//
//     // Broadcast to all OTHER clients that a new user joined
//     socket.broadcast.emit('user_status_changed', {
//       socketId: socket.id,
//       status: 'online',
//       customStatus: userInfo.customStatus,
//       timestamp: userInfo.lastSeen
//     });
//
//     // Broadcast updated user list to all clients
//     this.io.emit('user_list', {
//       users: Array.from(onlineUsers.values())
//     });
//
//     // Register event handlers for this socket
//     socket.on('message', (data: MessageData) => this.handleMessage(socket, data));
//     socket.on('chat', (data: ChatData) => this.handleChat(socket, data));
//     socket.on('private_message', (data: PrivateMessageData) => this.handlePrivateMessage(socket, data));
//     socket.on('join_room', (roomName: string) => this.handleJoinRoom(socket, roomName));
//     socket.on('room_message', (data: RoomMessageData) => this.handleRoomMessage(socket, data));
//     socket.on('typing_start', (data: TypingData) => this.handleTypingStart(socket, data));
//     socket.on('typing_stop', () => this.handleTypingStop(socket));
//     socket.on('file_share', (data: FileShareData) => this.handleFileShare(socket, data));
//
//     socket.on('status_update', (data: { status: 'online' | 'away' | 'busy', customStatus?: string }) => this.handleStatusUpdate(socket, data));
//     socket.on('user_info_update', (data: Partial<UserInfo>) => this.handleUserInfoUpdate(socket, data));
//     socket.on('get_user_list', () => this.handleGetUserList(socket));
//
//     socket.on('disconnect', (reason: string) => this.handleDisconnect(socket, reason));
//     socket.on('leave', () => this.handleLeave(socket));
//     socket.on('error', (error: Error) => this.handleError(socket, error));
//
//
//   }
//
//   // Send welcome message to newly connected client
//   private sendWelcome(socket: Socket): void {
//     socket.emit('welcome', {
//       message: 'Connected to Socket.IO server',
//       socketId: socket.id,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Handle regular messages with echo
//   private handleMessage(socket: Socket, data: MessageData): void {
//     console.log('📨 Received message:', data);
//
//     socket.emit('echo', {
//       original: data,
//       echo: `Echo: ${data.toString()}`,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Handle chat messages (broadcast to all)
//   private handleChat(socket: Socket, data: ChatData): void {
//     console.log('💬 Chat message:', data);
//
//     this.io.emit('chat', {
//       ...data,
//       socketId: socket.id,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Handle private messages between users
//   private handlePrivateMessage(socket: Socket, data: PrivateMessageData): void {
//     const { targetSocketId, message } = data;
//     console.log('🔒 Private message to:', targetSocketId);
//
//     socket.to(targetSocketId).emit('private_message', {
//       from: socket.id,
//       message,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Handle room joining
//   private handleJoinRoom(socket: Socket, roomName: string): void {
//     socket.join(roomName);
//     console.log(`🏠 Socket ${socket.id} joined room: ${roomName}`);
//
//     // Notify existing room members
//     socket.to(roomName).emit('user_joined', {
//       socketId: socket.id,
//       room: roomName,
//       timestamp: new Date().toISOString()
//     });
//
//     // Confirm to user
//     socket.emit('joined_room', { room: roomName });
//   }
//
//   // Handle room-specific messages
//   private handleRoomMessage(socket: Socket, data: RoomMessageData): void {
//     const { room, message } = data;
//     console.log(`🏠 Room message in ${room}:`, message);
//
//     this.io.to(room).emit('room_message', {
//       from: socket.id,
//       room,
//       message,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Handle typing indicators
//   private handleTypingStart(socket: Socket, data: TypingData): void {
//     socket.broadcast.emit('user_typing', {
//       socketId: socket.id,
//       ...data
//     });
//   }
//
//   private handleTypingStop(socket: Socket): void {
//     socket.broadcast.emit('user_stopped_typing', {
//       socketId: socket.id
//     });
//   }
//
//   // Handle file sharing
//   private handleFileShare(socket: Socket, data: FileShareData): void {
//     console.log('📎 File shared:', data.fileName);
//
//     socket.broadcast.emit('file_received', {
//       from: socket.id,
//       ...data,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Handle client disconnection
//   private handleDisconnect(socket: Socket, reason: string): void {
//     console.log('❌ Client disconnected:', socket.id, 'Reason:', reason);
//
//     socket.broadcast.emit('user_disconnected', {
//       socketId: socket.id,
//       reason,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Handle manual leave
//   private handleStatusUpdate(socket: Socket, data: { status: 'online' | 'away' | 'busy', customStatus?: string }): void {
//     const user = this.onlineUsers.get(socket.id);
//     if (!user) return;
//
//     // Update user status
//     const updatedUser: UserInfo = {
//       ...user,
//       status: data.status,
//       customStatus: data.customStatus,
//       lastSeen: new Date().toISOString()
//     };
//
//     this.onlineUsers.set(socket.id, updatedUser);
//     console.log('📱 User status updated:', user.username, 'to', data.status);
//
//     // Broadcast status change to all clients
//     this.io.emit('user_status_changed', {
//       socketId: socket.id,
//       status: data.status,
//       customStatus: data.customStatus,
//       timestamp: updatedUser.lastSeen
//     });
//
//     // Send updated user list
//     this.io.emit('user_list', {
//       users: Array.from(this.onlineUsers.values())
//     });
//   }
//
//   private handleUserInfoUpdate(socket: Socket, data: Partial<UserInfo>): void {
//     const user = this.onlineUsers.get(socket.id);
//     if (!user) return;
//
//     // Update user info (but preserve critical fields)
//     const updatedUser: UserInfo = {
//       ...user,
//       ...data,
//       socketId: socket.id, // Always preserve socket ID
//       lastSeen: new Date().toISOString()
//     };
//
//     this.onlineUsers.set(socket.id, updatedUser);
//     console.log('👤 User info updated:', updatedUser.username);
//
//     // Broadcast updated user list
//     this.io.emit('user_list', {
//       users: Array.from(this.onlineUsers.values())
//     });
//   }
//
//   private handleGetUserList(socket: Socket): void {
//     console.log('📋 User list requested by:', socket.id);
//     socket.emit('user_list', {
//       users: Array.from(this.onlineUsers.values())
//     });
//   }
//
// // Update your existing handleDisconnect method:
//   private handleDisconnect(socket: Socket, reason: string): void {
//     const user = this.onlineUsers.get(socket.id);
//     const username = user?.username || socket.id;
//
//     console.log('❌ Client disconnected:', socket.id, 'from', socket.handshake.address, 'reason:', reason);
//
//     // Remove user from online users
//     this.onlineUsers.delete(socket.id);
//     console.log('👤 User removed from online list:', username, '- Total online:', this.onlineUsers.size);
//
//     // Broadcast user disconnection to all remaining clients
//     socket.broadcast.emit('user_disconnected', {
//       socketId: socket.id,
//       reason: reason,
//       timestamp: new Date().toISOString()
//     });
//
//     // Send updated user list to all remaining clients
//     socket.broadcast.emit('user_list', {
//       users: Array.from(this.onlineUsers.values())
//     });
//
//     // Clean up any rooms the user was in
//     this.cleanupUserFromRooms(socket);
//   }
//
// // Update your existing handleLeave method:
//   private handleLeave(socket: Socket): void {
//     const user = this.onlineUsers.get(socket.id);
//     const username = user?.username || socket.id;
//
//     console.log('👋 Client leaving:', username);
//
//     // Remove user from online users
//     this.onlineUsers.delete(socket.id);
//
//     // Broadcast user leaving to all other clients
//     socket.broadcast.emit('user_disconnected', {
//       socketId: socket.id,
//       reason: 'user_initiated',
//       timestamp: new Date().toISOString()
//     });
//
//     // Send updated user list
//     socket.broadcast.emit('user_list', {
//       users: Array.from(this.onlineUsers.values())
//     });
//
//     // Clean up and disconnect
//     this.cleanupUserFromRooms(socket);
//     socket.disconnect(true);
//   }
//
// // Helper method to clean up user from rooms
//   private cleanupUserFromRooms(socket: Socket): void {
//     // Get all rooms the socket was in
//     const rooms = Array.from(socket.rooms);
//
//     rooms.forEach(room => {
//       if (room !== socket.id) { // Skip the default room (socket's own ID)
//         socket.leave(room);
//
//         // Notify others in the room that user left
//         socket.to(room).emit('user_left_room', {
//           socketId: socket.id,
//           room: room,
//           timestamp: new Date().toISOString()
//         });
//       }
//     });
//   }
//
// // Add a method to get online user count for heartbeat
//   private getOnlineUserCount(): number {
//     return this.onlineUsers.size;
//   }
//
// // Update your heartbeat method to include online user count
//   private sendHeartbeat(): void {
//     const heartbeatData = {
//       timestamp: new Date().toISOString(),
//       connectedClients: this.getOnlineUserCount() // Use actual online users count
//     };
//
//     this.io.emit('heartbeat', heartbeatData);
//     console.log('💓 Heartbeat sent to', this.getOnlineUserCount(), 'clients');
//   }
//
//   // Handle socket errors
//   private handleError(socket: Socket, error: Error): void {
//     console.error('🚨 Socket error:', error);
//   }
//
//   // Public methods for external message sending
//
//   // Send message to all connected clients
//   public broadcastMessage(eventName: string, data: MessageData): void {
//     this.io.emit(eventName, {
//       ...data,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Send message to specific socket
//   public sendToSocket(socketId: string, eventName: string, data: MessageData): void {
//     this.io.to(socketId).emit(eventName, {
//       ...data,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Send message to specific room
//   public sendToRoom(roomName: string, eventName: string, data: MessageData): void {
//     this.io.to(roomName).emit(eventName, {
//       ...data,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Send message to all clients except specific socket
//   public broadcastExcept(excludeSocketId: string, eventName: string, data: MessageData): void {
//     this.io.except(excludeSocketId).emit(eventName, {
//       ...data,
//       timestamp: new Date().toISOString()
//     });
//   }
//
//   // Get connected clients count
//   public getConnectedClientsCount(): number {
//     return this.io.engine.clientsCount;
//   }
//
//   // Get all socket IDs in a room
//   public async getSocketsInRoom(roomName: string): Promise<string[]> {
//     const sockets = await this.io.in(roomName).fetchSockets();
//     return sockets.map((socket) => socket.id);
//   }
//
//   // Force disconnect a socket
//   public disconnectSocket(socketId: string, reason: string = 'server_disconnect'): void {
//     const socket = this.io.sockets.sockets.get(socketId);
//     if (socket) {
//       socket.disconnect(true);
//       console.log(`🚪 Forcefully disconnected socket: ${socketId}, reason: ${reason}`);
//     }
//   }
//
//   // Start heartbeat mechanism
//   public startHeartbeat(interval: number = 30000): void {
//     this.heartbeatInterval = setInterval(() => {
//       this.io.emit('heartbeat', {
//         timestamp: new Date().toISOString(),
//         connectedClients: this.getConnectedClientsCount()
//       });
//     }, interval);
//     console.log(`💓 Heartbeat started with ${interval}ms interval`);
//   }
//
//   // Stop heartbeat mechanism
//   public stopHeartbeat(): void {
//     if (this.heartbeatInterval) {
//       clearInterval(this.heartbeatInterval);
//       this.heartbeatInterval = null;
//       console.log('💓 Heartbeat stopped');
//     }
//   }
//
//   // Setup graceful shutdown
//   private setupGracefulShutdown(): void {
//     process.on('SIGTERM', () => {
//       console.log('🛑 SIGTERM received, shutting down gracefully');
//       this.shutdown();
//     });
//
//     process.on('SIGINT', () => {
//       console.log('🛑 SIGINT received, shutting down gracefully');
//       this.shutdown();
//     });
//   }
//
//   // Graceful shutdown
//   public shutdown(): void {
//     this.stopHeartbeat();
//
//     this.io.close(() => {
//       this.server.close(() => {
//         console.log('✅ Server closed');
//         process.exit(0);
//       });
//     });
//   }
//
//   // Start the server
//   public start(hostname = '0.0.0.0'): SocketIOServer {
//     this.server.listen(this.port, hostname, () => {
//       console.log(`✅ Socket.IO Server running at http://${hostname}:${this.port}`);
//       console.log(`🔌 WebSocket endpoint: ws://${hostname}:${this.port}/socket.io/`);
//       this.startHeartbeat();
//     });
//
//     return this;
//   }
//
//   // Stop the server
//   public stop(): void {
//     this.shutdown();
//   }
// }
//
// // Usage example:
// export default SocketIOServer;
//
// // To use the class:
// const socketServer = new SocketIOServer(4000); // Now allows all origins by default
// // Or explicitly allow all origins:
// // const socketServer = new SocketIOServer(4000, true);
// // Or specify specific origins:
// // const socketServer = new SocketIOServer(4000, ['http://localhost:3000', 'https://mydomain.com']);
// socketServer.start();
//
// // Send messages programmatically:
// socketServer.broadcastMessage('announcement', { message: 'Server maintenance in 5 minutes' });
// socketServer.sendToRoom('general', 'room_notification', { message: 'Welcome to the general room!' });
// socketServer.sendToSocket('specific-socket-id', 'private_notification', { message: 'Hello there!' });