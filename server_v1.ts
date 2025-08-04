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

// Extended interface to track multiple connections per user
interface UserSession {
  username: string;
  socketIds: Set<string>; // Track all socket connections for this user
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
  private onlineUsers: Map<string, UserInfo> = new Map(); // Socket ID -> UserInfo
  private userSessions: Map<string, UserSession> = new Map(); // Username -> UserSession
  private socketToUsername: Map<string, string> = new Map(); // Socket ID -> Username

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

    const username = socket.handshake.auth?.username || socket.handshake.auth?.userInfo?.username || `User ${socket.id.slice(0, 6)}`;

    const userInfo: UserInfo = {
      socketId: socket.id,
      username: username,
      status: 'online',
      lastSeen: new Date().toISOString(),
      avatar: socket.handshake.auth?.userInfo?.avatar,
      customStatus: socket.handshake.auth?.userInfo?.customStatus
    };

    // Add to socket-based tracking (for backward compatibility)
    this.onlineUsers.set(socket.id, userInfo);
    this.socketToUsername.set(socket.id, username);

    // Add or update user session
    this.addUserSession(username, socket.id, userInfo);

    console.log('👤 User added to online list:', username, '- Total unique users:', this.userSessions.size);

    // Send current unique user list to the newly connected client
    socket.emit('user_list', {
      users: this.getUniqueUserList()
    });

    // Check if this is a new user (first connection) or additional connection
    const userSession = this.userSessions.get(username);
    if (userSession && userSession.socketIds.size === 1) {
      // First connection for this user - broadcast to others
      socket.broadcast.emit('user_status_changed', {
        username: username,
        socketId: socket.id,
        status: 'online',
        customStatus: userInfo.customStatus,
        timestamp: userInfo.lastSeen
      });
    }

    // Broadcast updated user list to all clients
    this.io.emit('user_list', {
      users: this.getUniqueUserList()
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

  // Add or update user session
  private addUserSession(username: string, socketId: string, userInfo: UserInfo): void {
    let userSession = this.userSessions.get(username);

    if (!userSession) {
      // New user
      userSession = {
        username: username,
        socketIds: new Set([socketId]),
        status: userInfo.status,
        lastSeen: userInfo.lastSeen,
        avatar: userInfo.avatar,
        customStatus: userInfo.customStatus
      };
      this.userSessions.set(username, userSession);
    } else {
      // Existing user, add new socket connection
      userSession.socketIds.add(socketId);
      userSession.lastSeen = userInfo.lastSeen;
      // Update other fields if provided
      if (userInfo.avatar) userSession.avatar = userInfo.avatar;
      if (userInfo.customStatus) userSession.customStatus = userInfo.customStatus;
    }
  }

  // Remove socket from user session
  private removeSocketFromSession(socketId: string): boolean {
    const username = this.socketToUsername.get(socketId);
    if (!username) return false;

    const userSession = this.userSessions.get(username);
    if (!userSession) return false;

    userSession.socketIds.delete(socketId);

    // If no more connections for this user, remove the session
    if (userSession.socketIds.size === 0) {
      this.userSessions.delete(username);
      return true; // User completely disconnected
    }

    return false; // User still has other connections
  }

  // Get unique user list (one entry per username)
  private getUniqueUserList(): UserInfo[] {
    return Array.from(this.userSessions.values()).map(session => ({
      socketId: Array.from(session.socketIds)[0], // Use first socket ID as representative
      username: session.username,
      status: session.status,
      lastSeen: session.lastSeen,
      avatar: session.avatar,
      customStatus: session.customStatus
    }));
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

    const username = this.socketToUsername.get(socket.id);

    this.io.emit('chat', {
      ...data,
      socketId: socket.id,
      username: username,
      timestamp: new Date().toISOString()
    });
  }

  // Handle private messages between users
  private handlePrivateMessage(socket: Socket, data: PrivateMessageData): void {
    const { targetSocketId, message } = data;
    console.log('🔒 Private message to:', targetSocketId);

    const fromUsername = this.socketToUsername.get(socket.id);

    socket.to(targetSocketId).emit('private_message', {
      from: socket.id,
      fromUsername: fromUsername,
      message,
      timestamp: new Date().toISOString()
    });
  }

  // Handle room joining
  private handleJoinRoom(socket: Socket, roomName: string): void {
    socket.join(roomName);
    const username = this.socketToUsername.get(socket.id);
    console.log(`🏠 Socket ${socket.id} (${username}) joined room: ${roomName}`);

    // Notify existing room members
    socket.to(roomName).emit('user_joined', {
      socketId: socket.id,
      username: username,
      room: roomName,
      timestamp: new Date().toISOString()
    });

    // Confirm to user
    socket.emit('joined_room', { room: roomName });
  }

  // Handle room-specific messages
  private handleRoomMessage(socket: Socket, data: RoomMessageData): void {
    const { room, message } = data;
    const username = this.socketToUsername.get(socket.id);
    console.log(`🏠 Room message in ${room}:`, message);

    this.io.to(room).emit('room_message', {
      from: socket.id,
      fromUsername: username,
      room,
      message,
      timestamp: new Date().toISOString()
    });
  }

  // Handle typing indicators
  private handleTypingStart(socket: Socket, data: TypingData): void {
    const username = this.socketToUsername.get(socket.id);
    socket.broadcast.emit('user_typing', {
      socketId: socket.id,
      username: username,
      ...data
    });
  }

  private handleTypingStop(socket: Socket): void {
    const username = this.socketToUsername.get(socket.id);
    socket.broadcast.emit('user_stopped_typing', {
      socketId: socket.id,
      username: username
    });
  }

  // Handle file sharing
  private handleFileShare(socket: Socket, data: FileShareData): void {
    console.log('📎 File shared:', data.fileName);
    const username = this.socketToUsername.get(socket.id);

    socket.broadcast.emit('file_received', {
      from: socket.id,
      fromUsername: username,
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Handle status updates
  private handleStatusUpdate(socket: Socket, data: { status: 'online' | 'away' | 'busy', customStatus?: string }): void {
    console.log('🔄 Processing status update for', socket.id, ':', data);

    const username = this.socketToUsername.get(socket.id);
    if (!username) {
      console.warn('⚠️ Username not found for socket:', socket.id);
      return;
    }

    const userSession = this.userSessions.get(username);
    if (!userSession) {
      console.warn('⚠️ User session not found for username:', username);
      return;
    }

    // Update user session
    userSession.status = data.status;
    userSession.customStatus = data.customStatus || userSession.customStatus;
    userSession.lastSeen = new Date().toISOString();

    // Also update in onlineUsers for backward compatibility
    const user = this.onlineUsers.get(socket.id);
    if (user) {
      user.status = data.status;
      user.customStatus = data.customStatus || user.customStatus;
      user.lastSeen = userSession.lastSeen;
    }

    console.log('✅ User status updated:', username, 'to', data.status);

    // Broadcast status change to all clients
    this.io.emit('user_status_changed', {
      username: username,
      socketId: socket.id,
      status: data.status,
      customStatus: data.customStatus,
      timestamp: userSession.lastSeen
    });

    // Send updated user list
    this.io.emit('user_list', {
      users: this.getUniqueUserList()
    });

    console.log('📤 Status update broadcasted to all clients');
  }

  private handleUserInfoUpdate(socket: Socket, data: Partial<UserInfo>): void {
    const username = this.socketToUsername.get(socket.id);
    if (!username) return;

    const userSession = this.userSessions.get(username);
    const user = this.onlineUsers.get(socket.id);

    if (!userSession || !user) return;

    // Update user session
    if (data.avatar !== undefined) userSession.avatar = data.avatar;
    if (data.customStatus !== undefined) userSession.customStatus = data.customStatus;
    if (data.status) userSession.status = data.status;
    userSession.lastSeen = new Date().toISOString();

    // Update individual user info for backward compatibility
    Object.assign(user, {
      ...data,
      socketId: socket.id, // Always preserve socket ID
      username: username, // Always preserve username
      lastSeen: userSession.lastSeen
    });

    console.log('👤 User info updated:', username);

    // Broadcast updated user list
    this.io.emit('user_list', {
      users: this.getUniqueUserList()
    });
  }

  private handleGetUserList(socket: Socket): void {
    console.log('📋 User list requested by:', socket.id);
    socket.emit('user_list', {
      users: this.getUniqueUserList()
    });
  }

  // Handle disconnections
  private handleDisconnect(socket: Socket, reason: string): void {
    const username = this.socketToUsername.get(socket.id);

    console.log('❌ Client disconnected:', socket.id, 'from', socket.handshake.address, 'reason:', reason);

    // Remove from socket-based tracking
    this.onlineUsers.delete(socket.id);

    // Remove from user session and check if user is completely disconnected
    const userCompletelyDisconnected = this.removeSocketFromSession(socket.id);
    this.socketToUsername.delete(socket.id);

    if (userCompletelyDisconnected && username) {
      console.log('👤 User completely disconnected:', username, '- Total unique users:', this.userSessions.size);

      // Broadcast user disconnection only if completely disconnected
      socket.broadcast.emit('user_disconnected', {
        username: username,
        socketId: socket.id,
        reason: reason,
        timestamp: new Date().toISOString()
      });
    } else if (username) {
      console.log('👤 User still has other connections:', username, '- Total unique users:', this.userSessions.size);
    }

    // Send updated user list to all remaining clients
    socket.broadcast.emit('user_list', {
      users: this.getUniqueUserList()
    });

    // Clean up any rooms the user was in
    this.cleanupUserFromRooms(socket);
  }

  // Handle user-initiated leave
  private handleLeave(socket: Socket): void {
    const username = this.socketToUsername.get(socket.id);

    console.log('👋 Client leaving:', username);

    // Remove from tracking
    this.onlineUsers.delete(socket.id);
    const userCompletelyDisconnected = this.removeSocketFromSession(socket.id);
    this.socketToUsername.delete(socket.id);

    if (userCompletelyDisconnected && username) {
      // Broadcast user leaving to all other clients only if completely disconnected
      socket.broadcast.emit('user_disconnected', {
        username: username,
        socketId: socket.id,
        reason: 'user_initiated',
        timestamp: new Date().toISOString()
      });
    }

    // Send updated user list
    socket.broadcast.emit('user_list', {
      users: this.getUniqueUserList()
    });

    // Clean up and disconnect
    this.cleanupUserFromRooms(socket);
    socket.disconnect(true);
  }

  // Helper method to clean up user from rooms
  private cleanupUserFromRooms(socket: Socket): void {
    // Get all rooms the socket was in
    const rooms = Array.from(socket.rooms);
    const username = this.socketToUsername.get(socket.id);

    rooms.forEach(room => {
      if (room !== socket.id) { // Skip the default room (socket's own ID)
        socket.leave(room);

        // Notify others in the room that user left
        socket.to(room).emit('user_left_room', {
          socketId: socket.id,
          username: username,
          room: room,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  // Get online user count (unique users)
  private getOnlineUserCount(): number {
    return this.userSessions.size;
  }

  // Send heartbeat with unique user count
  private sendHeartbeat(): void {
    const heartbeatData = {
      timestamp: new Date().toISOString(),
      connectedClients: this.getOnlineUserCount(),
      totalSockets: this.onlineUsers.size
    };

    this.io.emit('heartbeat', heartbeatData);
    console.log('💓 Heartbeat sent to', this.getOnlineUserCount(), 'unique users (', this.onlineUsers.size, 'total sockets)');
  }

  // Handle socket errors
  private handleError(socket: Socket, error: Error): void {
    console.error('🚨 Socket error:', error);
  }

  // Debug method to check online users state
  private debugOnlineUsers(): void {
    console.log('🐛 DEBUG: Current unique users:');
    this.userSessions.forEach((session, username) => {
      console.log(`  - ${username}: ${session.status} (${session.socketIds.size} connections: ${Array.from(session.socketIds).join(', ')})`);
    });
    console.log(`🐛 Total: ${this.userSessions.size} unique users, ${this.onlineUsers.size} total sockets`);
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

  // Send message to all sockets of a specific user
  public sendToUser(username: string, eventName: string, data: MessageData): void {
    const userSession = this.userSessions.get(username);
    if (userSession) {
      userSession.socketIds.forEach(socketId => {
        this.io.to(socketId).emit(eventName, {
          ...data,
          timestamp: new Date().toISOString()
        });
      });
    }
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

  // Get connected clients count (total sockets)
  public getConnectedClientsCount(): number {
    return this.io.engine.clientsCount;
  }

  // Get unique users count
  public getUniqueUsersCount(): number {
    return this.userSessions.size;
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

  // Force disconnect all sockets of a user
  public disconnectUser(username: string, reason: string = 'server_disconnect'): void {
    const userSession = this.userSessions.get(username);
    if (userSession) {
      userSession.socketIds.forEach(socketId => {
        this.disconnectSocket(socketId, reason);
      });
    }
  }

  // Start heartbeat mechanism
  public startHeartbeat(interval: number = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
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

  // Public method to get unique users (for debugging)
  public getUniqueUsers(): UserInfo[] {
    return this.getUniqueUserList();
  }

  // Public method to get online users (backward compatibility)
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
// class SocketIOServer {
//   private port: number;
//   private server: HttpServer;
//   private io: Server;
//   private heartbeatInterval: NodeJS.Timeout | null;
//   private onlineUsers: Map<string, UserInfo> = new Map(); // FIX: Make it instance property
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
//       username: socket.handshake.auth?.username || socket.handshake.auth?.userInfo?.username || `User ${socket.id.slice(0, 6)}`,
//       status: 'online',
//       lastSeen: new Date().toISOString(),
//       avatar: socket.handshake.auth?.userInfo?.avatar,
//       customStatus: socket.handshake.auth?.userInfo?.customStatus
//     };
//
//     // Add user to online users map
//     this.onlineUsers.set(socket.id, userInfo); // FIX: Use this.onlineUsers
//     console.log('👤 User added to online list:', userInfo.username, '- Total online:', this.onlineUsers.size);
//
//     // Send current user list to the newly connected client
//     socket.emit('user_list', {
//       users: Array.from(this.onlineUsers.values())
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
//       users: Array.from(this.onlineUsers.values())
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
//     // FIX: Add proper status update handler with logging
//     socket.on('status_update', (data: { status: 'online' | 'away' | 'busy', customStatus?: string }) => {
//       console.log('📱 Received status_update from', socket.id, ':', data);
//       this.handleStatusUpdate(socket, data);
//     });
//
//     socket.on('user_info_update', (data: Partial<UserInfo>) => this.handleUserInfoUpdate(socket, data));
//     socket.on('get_user_list', () => this.handleGetUserList(socket));
//
//     socket.on('disconnect', (reason: string) => this.handleDisconnect(socket, reason));
//     socket.on('leave', () => this.handleLeave(socket));
//     socket.on('error', (error: Error) => this.handleError(socket, error));
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
//   // FIX: Proper status update handler
//   private handleStatusUpdate(socket: Socket, data: { status: 'online' | 'away' | 'busy', customStatus?: string }): void {
//     console.log('🔄 Processing status update for', socket.id, ':', data);
//
//     const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
//     if (!user) {
//       console.warn('⚠️ User not found in online users:', socket.id);
//       return;
//     }
//
//     console.log('👤 Current user:', user);
//
//     // Update user status
//     const updatedUser: UserInfo = {
//       ...user,
//       status: data.status,
//       customStatus: data.customStatus || user.customStatus,
//       lastSeen: new Date().toISOString()
//     };
//
//     this.onlineUsers.set(socket.id, updatedUser); // FIX: Use this.onlineUsers
//     console.log('✅ User status updated:', updatedUser.username, 'to', data.status);
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
//       users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
//     });
//
//     console.log('📤 Status update broadcasted to all clients');
//   }
//
//   private handleUserInfoUpdate(socket: Socket, data: Partial<UserInfo>): void {
//     const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
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
//     this.onlineUsers.set(socket.id, updatedUser); // FIX: Use this.onlineUsers
//     console.log('👤 User info updated:', updatedUser.username);
//
//     // Broadcast updated user list
//     this.io.emit('user_list', {
//       users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
//     });
//   }
//
//   private handleGetUserList(socket: Socket): void {
//     console.log('📋 User list requested by:', socket.id);
//     socket.emit('user_list', {
//       users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
//     });
//   }
//
//   // FIX: Updated handleDisconnect method (remove duplicate)
//   private handleDisconnect(socket: Socket, reason: string): void {
//     const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
//     const username = user?.username || socket.id;
//
//     console.log('❌ Client disconnected:', socket.id, 'from', socket.handshake.address, 'reason:', reason);
//
//     // Remove user from online users
//     this.onlineUsers.delete(socket.id); // FIX: Use this.onlineUsers
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
//       users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
//     });
//
//     // Clean up any rooms the user was in
//     this.cleanupUserFromRooms(socket);
//   }
//
//   // FIX: Updated handleLeave method
//   private handleLeave(socket: Socket): void {
//     const user = this.onlineUsers.get(socket.id); // FIX: Use this.onlineUsers
//     const username = user?.username || socket.id;
//
//     console.log('👋 Client leaving:', username);
//
//     // Remove user from online users
//     this.onlineUsers.delete(socket.id); // FIX: Use this.onlineUsers
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
//       users: Array.from(this.onlineUsers.values()) // FIX: Use this.onlineUsers
//     });
//
//     // Clean up and disconnect
//     this.cleanupUserFromRooms(socket);
//     socket.disconnect(true);
//   }
//
//   // Helper method to clean up user from rooms
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
//   // Add a method to get online user count for heartbeat
//   private getOnlineUserCount(): number {
//     return this.onlineUsers.size; // FIX: Use this.onlineUsers
//   }
//
//   // FIX: Updated heartbeat method to use correct user count
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
//   // Debug method to check online users state
//   private debugOnlineUsers(): void {
//     console.log('🐛 DEBUG: Current online users:');
//     this.onlineUsers.forEach((user, socketId) => {
//       console.log(`  - ${socketId}: ${user.username} (${user.status})`);
//     });
//     console.log(`🐛 Total: ${this.onlineUsers.size} users`);
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
//       this.sendHeartbeat(); // FIX: Use the corrected sendHeartbeat method
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
//
//     // await connectToDatabase();
//
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
//
//   // Public method to get online users (for debugging)
//   public getOnlineUsers(): UserInfo[] {
//     return Array.from(this.onlineUsers.values());
//   }
//
//   // Public method to debug user state
//   public debugUsers(): void {
//     this.debugOnlineUsers();
//   }
// }
//
// // Usage example:
// export default SocketIOServer;
//
// // To use the class:
// const socketServer = new SocketIOServer(4000);
//
// socketServer.start();
