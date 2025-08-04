import { MongoClient, Db } from 'mongodb';

type PromiseType<T> = Promise<T>;

// MongoDB connection configuration
interface MongoConfig {
    uri: string;
    dbName: string;
    options?: {
        maxPoolSize?: number;
        serverSelectionTimeoutMS?: number;
        socketTimeoutMS?: number;
        connectTimeoutMS?: number;
        maxIdleTimeMS?: number;
    };
}

// Singleton MongoDB connection manager
class MongoConnection {
    private static instance: MongoConnection;
    private client: MongoClient | null = null;
    private db: Db | null = null;
    private config: MongoConfig;
    private isConnected: boolean = false;

    private constructor(config: MongoConfig) {
        this.config = config;
    }

    // Get singleton instance
    public static getInstance(config?: MongoConfig): MongoConnection {
        if (!MongoConnection.instance) {
            if (!config) {
                throw new Error('MongoDB configuration is required for first initialization');
            }
            MongoConnection.instance = new MongoConnection(config);
        }
        return MongoConnection.instance;
    }

    // Connect to MongoDB
    public async connect(): Promise<void> {
        if (this.isConnected && this.client) {
            return;
        }

        try {
            console.log('Connecting to MongoDB...');

            this.client = new MongoClient(this.config.uri, {
                maxPoolSize: 10,
                serverSelectionTimeoutMS: 5000,
                socketTimeoutMS: 45000,
                connectTimeoutMS: 10000,
                maxIdleTimeMS: 30000,
                ...this.config.options
            });

            await this.client.connect();
            this.db = this.client.db(this.config.dbName);
            this.isConnected = true;

            // Setup event listeners
            this.client.on('close', () => {
                console.log('MongoDB connection closed');
                this.isConnected = false;
            });

            this.client.on('error', (error) => {
                console.error('MongoDB connection error:', error);
                this.isConnected = false;
            });

            this.client.on('serverClosed', () => {
                console.log('MongoDB server connection closed');
                this.isConnected = false;
            });

            console.log(`Connected to MongoDB database: ${this.config.dbName}`);

        } catch (error) {
            console.error('Failed to connect to MongoDB:', error);
            this.isConnected = false;
            throw error;
        }
    }

    // Disconnect from MongoDB
    public async disconnect(): Promise<void> {
        if (this.client && this.isConnected) {
            try {
                await this.client.close();
                console.log('Disconnected from MongoDB');
            } catch (error) {
                console.error('Error disconnecting from MongoDB:', error);
            } finally {
                this.client = null;
                this.db = null;
                this.isConnected = false;
            }
        }
    }

    // Get database instance
    public getDatabase(): Db {
        if (!this.db || !this.isConnected) {
            throw new Error('MongoDB not connected. Call connect() first.');
        }
        return this.db;
    }

    // Get client instance
    public getClient(): MongoClient {
        if (!this.client || !this.isConnected) {
            throw new Error('MongoDB not connected. Call connect() first.');
        }
        return this.client;
    }

    // Check connection status
    public isConnectionActive(): boolean {
        return this.isConnected && this.client !== null;
    }

    // Health check
    public async healthCheck(): Promise<{ status: string; timestamp: Date; dbName: string }> {
        try {
            if (!this.db) {
                throw new Error('Database not connected');
            }

            await this.db.admin().ping();
            return {
                status: 'healthy',
                timestamp: new Date(),
                dbName: this.config.dbName
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                timestamp: new Date(),
                dbName: this.config.dbName
            };
        }
    }

    // Get database statistics
    public async getDatabaseStats(): Promise<any> {
        if (!this.db) {
            throw new Error('Database not connected');
        }
        return await this.db.stats();
    }

    // List collections
    public async listCollections(): Promise<string[]> {
        if (!this.db) {
            throw new Error('Database not connected');
        }

        const collections = await this.db.listCollections().toArray();
        return collections.map(col => col.name);
    }
}

// Configuration helper
export function createMongoConfig(): MongoConfig {
    const uri = process.env['MONGODB_URI'];
    if (!uri) {
        throw new Error('MONGODB_URI environment variable is required');
    }

    return {
        uri,
        dbName: process.env['MONGODB_DB_NAME'] || 'wivroosearch_dev',
        options: {
            maxPoolSize: parseInt(process.env['MONGODB_MAX_POOL_SIZE'] || '10'),
            serverSelectionTimeoutMS: parseInt(process.env['MONGODB_SERVER_SELECTION_TIMEOUT'] || '5000'),
            socketTimeoutMS: parseInt(process.env['MONGODB_SOCKET_TIMEOUT'] || '45000'),
            connectTimeoutMS: parseInt(process.env['MONGODB_CONNECT_TIMEOUT'] || '10000'),
            maxIdleTimeMS: parseInt(process.env['MONGODB_MAX_IDLE_TIME'] || '30000'),
        }
    };
}

// Initialize MongoDB connection
// export async function initializeMongoDataBase(): Promise<MongoConnection> {
//     const config: MongoConfig = createMongoConfig();
//     const mongo: MongoConnection = MongoConnection.getInstance(config);
//     await mongo.connect();
//     return mongo;
// }

export async function initializeMongoDataBase() {
    const config = createMongoConfig();
    const mongo = MongoConnection.getInstance(config);
    await mongo.connect();
    return mongo;
}

export function initializeMongoDataBaseV2(): Promise<MongoConnection> {
    return (async () => {
        const config = createMongoConfig();
        const mongo = MongoConnection.getInstance(config);
        await mongo.connect();
        return mongo;
    })();
}

// Get existing MongoDB connection
export function getMongoDB(): MongoConnection {
    return MongoConnection.getInstance();
}

// Graceful shutdown handler
export async function closeMongoDB(): Promise<void> {
    const mongo = MongoConnection.getInstance();
    await mongo.disconnect();
}

// Export types and classes
export { MongoConnection, MongoConfig };