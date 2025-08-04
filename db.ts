import { MongoClient, Db, Collection, ObjectId, Filter, UpdateFilter, FindOptions, ClientSession, WithId } from 'mongodb';
import { promises as fs } from 'fs';

// Type definitions
interface BaseDocument {
    _id?: ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
}

interface PaginationOptions {
    page?: number;
    limit?: number;
    sort?: Record<string, 1 | -1>;
    projection?: Record<string, 0 | 1>;
}

interface PaginationResult<T> {
    data: T[];
    pagination: {
        currentPage: number;
        totalPages: number;
        totalItems: number;
        itemsPerPage: number;
        hasNext: boolean;
        hasPrev: boolean;
    };
}

interface SearchOptions {
    limit?: number;
    sort?: Record<string, any>;
}

interface GroupByOptions {
    countField?: string;
    match?: Filter<any>;
    sort?: Record<string, 1 | -1>;
}

interface GroupByResult {
    _id: any;
    [key: string]: any;
}

interface HealthCheckResult {
    status: 'healthy' | 'unhealthy';
    timestamp: Date;
    error?: string;
}

interface CollectionInfo {
    name: string;
    documentCount: number;
    indexes: IndexInfo[];
    storageSize?: number;
    avgObjSize?: number;
}

interface IndexInfo {
    name: string;
    keys: Record<string, any>;
    unique: boolean;
}

interface ExportImportOptions {
    dropFirst?: boolean;
}

interface ConnectionOptions {
    maxPoolSize?: number;
    serverSelectionTimeoutMS?: number;
    socketTimeoutMS?: number;
    [key: string]: any;
}

// Utility functions for common MongoDB operations
class MongoUtils {
    private client: MongoClient;
    private db: Db;

    constructor(client: MongoClient, database: Db) {
        this.client = client;
        this.db = database;
    }

    // Validate ObjectId
    static isValidObjectId(id: string): boolean {
        return ObjectId.isValid(id);
    }

    // Convert string to ObjectId
    static toObjectId(id: string | ObjectId): ObjectId {
        if (id instanceof ObjectId) {
            return id;
        }

        try {
            return new ObjectId(id);
        } catch (error) {
            throw new Error(`Invalid ObjectId: ${id}`);
        }
    }

    // Generic CRUD operations
    async create<T extends BaseDocument>(
        collectionName: string,
        document: Omit<T, '_id' | 'createdAt' | 'updatedAt'>
    ): Promise<T> {
        const collection = this.db.collection<T>(collectionName);
        const now = new Date();

        const documentWithTimestamps = {
            ...document,
            createdAt: now,
            updatedAt: now
        } as any;

        const result = await collection.insertOne(documentWithTimestamps);

        return {
            _id: result.insertedId,
            ...documentWithTimestamps,
        } as T;
    }

    async findById<T extends BaseDocument>(
        collectionName: string,
        id: string | ObjectId
    ): Promise<T | null> {
        const collection = this.db.collection<T>(collectionName);
        const result = await collection.findOne({ _id: MongoUtils.toObjectId(id) } as Filter<T>);
        return result as T | null;
    }

    async findMany<T extends BaseDocument>(
        collectionName: string,
        filter: Filter<T> = {},
        options: FindOptions<T> = {}
    ): Promise<T[]> {
        const collection = this.db.collection<T>(collectionName);
        const {
            sort = {},
            limit = 0,
            skip = 0,
            projection = {}
        } = options;

        const result = await collection
            .find(filter, { projection })
            .sort(sort)
            .skip(skip)
            .limit(limit)
            .toArray();

        return result as T[];
    }

    async updateById<T extends BaseDocument>(
        collectionName: string,
        id: string | ObjectId,
        update: Partial<Omit<T, '_id' | 'createdAt'>>
    ): Promise<boolean> {
        const collection = this.db.collection<T>(collectionName);

        const updateDoc: UpdateFilter<T> = {
            $set: {
                ...update,
                updatedAt: new Date()
            } as Partial<T>
        };

        const result = await collection.updateOne(
            { _id: MongoUtils.toObjectId(id) } as Filter<T>,
            updateDoc
        );

        if (result.matchedCount === 0) {
            throw new Error(`Document with id ${id} not found`);
        }

        return result.modifiedCount > 0;
    }

    async deleteById<T extends BaseDocument>(
        collectionName: string,
        id: string | ObjectId
    ): Promise<boolean> {
        const collection = this.db.collection<T>(collectionName);
        const result = await collection.deleteOne({
            _id: MongoUtils.toObjectId(id)
        } as Filter<T>);

        if (result.deletedCount === 0) {
            throw new Error(`Document with id ${id} not found`);
        }

        return true;
    }

    // Pagination helper
    async paginate<T extends BaseDocument>(
        collectionName: string,
        filter: Filter<T> = {},
        options: PaginationOptions = {}
    ): Promise<PaginationResult<T>> {
        const collection = this.db.collection<T>(collectionName);
        const {
            page = 1,
            limit = 10,
            sort = { _id: -1 },
            projection = {}
        } = options;

        const skip = (page - 1) * limit;

        const [data, total] = await Promise.all([
            collection
                .find(filter, { projection })
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .toArray()
                .then(result => result as T[]),
            collection.countDocuments(filter)
        ]);

        return {
            data,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalItems: total,
                itemsPerPage: limit,
                hasNext: page < Math.ceil(total / limit),
                hasPrev: page > 1
            }
        };
    }

    // Search with text index
    async search<T extends BaseDocument>(
        collectionName: string,
        searchTerm: string,
        options: SearchOptions = {}
    ): Promise<T[]> {
        const collection = this.db.collection<T>(collectionName);
        const {
            limit = 10,
            sort = { score: { $meta: 'textScore' } }
        } = options;

        const result = await collection
            .find(
                { $text: { $search: searchTerm } } as Filter<T>
            )
            .sort(sort)
            .limit(limit)
            .toArray();

        return result as T[];
    }

    // Aggregate with common patterns
    async groupBy(
        collectionName: string,
        groupField: string,
        options: GroupByOptions = {}
    ): Promise<GroupByResult[]> {
        const collection = this.db.collection(collectionName);
        const {
            countField = 'count',
            match = {},
            sort = { [countField]: -1 }
        } = options;

        const result = await collection.aggregate([
            { $match: match },
            {
                $group: {
                    _id: `${groupField}`,
                    [countField]: { $sum: 1 }
                }
            },
            { $sort: sort }
        ]).toArray();

        return result as GroupByResult[];
    }

    // Backup collection to JSON
    async exportCollection(collectionName: string, filePath: string): Promise<number> {
        const collection = this.db.collection(collectionName);

        const data = await collection.find({}).toArray();
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));

        return data.length;
    }

    // Restore collection from JSON
    async importCollection(
        collectionName: string,
        filePath: string,
        options: ExportImportOptions = {}
    ): Promise<number> {
        const collection = this.db.collection(collectionName);
        const { dropFirst = false } = options;

        if (dropFirst) {
            await collection.drop().catch(() => {}); // Ignore if doesn't exist
        }

        const fileContent = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(fileContent);

        if (Array.isArray(data) && data.length > 0) {
            const result = await collection.insertMany(data);
            return result.insertedCount;
        }

        return 0;
    }

    // Health check
    async healthCheck(): Promise<HealthCheckResult> {
        try {
            await this.db.admin().ping();
            return { status: 'healthy', timestamp: new Date() };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: (error as Error).message,
                timestamp: new Date()
            };
        }
    }

    // Get database stats
    async getStats(): Promise<any> {
        return await this.db.stats();
    }

    // Get collection info
    async getCollectionInfo(collectionName: string): Promise<CollectionInfo> {
        const collection = this.db.collection(collectionName);

        const [stats, indexes, count] = await Promise.all([
            this.db.command({ collStats: collectionName }).catch(() => ({})),
            collection.indexes(),
            collection.countDocuments({})
        ]);

        const collStats = stats as any;

        return {
            name: collectionName,
            documentCount: count,
            indexes: indexes.map((idx: any): IndexInfo => ({
                name: idx.name || 'unknown',
                keys: idx.key || {},
                unique: idx.unique || false
            })),
            storageSize: collStats.storageSize || 0,
            avgObjSize: collStats.avgObjSize || 0
        };
    }

    // Execute transaction
    async withTransaction<T>(
        operation: (session: ClientSession) => Promise<T>
    ): Promise<T> {
        const session = this.client.startSession();

        try {
            return await session.withTransaction(async () => {
                return await operation(session);
            });
        } finally {
            await session.endSession();
        }
    }
}

// Connection manager with connection pooling
class ConnectionManager {
    private url: string;
    private options: ConnectionOptions;
    private client: MongoClient | null = null;
    private isConnected: boolean = false;

    constructor(url: string, options: ConnectionOptions = {}) {
        this.url = url;
        this.options = {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            ...options
        };
    }

    async connect(): Promise<MongoClient> {
        if (this.isConnected && this.client) return this.client;

        try {
            this.client = new MongoClient(this.url, this.options);
            await this.client.connect();
            this.isConnected = true;

            // Handle connection events
            this.client.on('close', () => {
                this.isConnected = false;
                console.log('MongoDB connection closed');
            });

            this.client.on('error', (error: Error) => {
                console.error('MongoDB connection error:', error);
            });

            console.log('Connected to MongoDB');
            return this.client;
        } catch (error) {
            console.error('Failed to connect to MongoDB:', error);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.client && this.isConnected) {
            await this.client.close();
            this.isConnected = false;
            this.client = null;
            console.log('Disconnected from MongoDB');
        }
    }

    getDatabase(dbName: string): Db {
        if (!this.isConnected || !this.client) {
            throw new Error('Not connected to MongoDB');
        }
        return this.client.db(dbName);
    }

    getUtils(dbName: string): MongoUtils {
        if (!this.client) {
            throw new Error('Not connected to MongoDB');
        }
        const db = this.getDatabase(dbName);
        return new MongoUtils(this.client, db);
    }

    getClient(): MongoClient {
        if (!this.client) {
            throw new Error('Not connected to MongoDB');
        }
        return this.client;
    }

    isConnectionActive(): boolean {
        return this.isConnected;
    }
}

// Repository pattern implementation
abstract class BaseRepository<T extends BaseDocument> {
    protected collection: Collection<T>;
    protected utils: MongoUtils;

    constructor(
        protected collectionName: string,
        protected db: Db,
        protected client: MongoClient
    ) {
        this.collection = db.collection<T>(collectionName);
        this.utils = new MongoUtils(client, db);
    }

    async create(document: Omit<T, '_id' | 'createdAt' | 'updatedAt'>): Promise<T> {
        return this.utils.create<T>(this.collectionName, document);
    }

    async findById(id: string | ObjectId): Promise<T | null> {
        return this.utils.findById<T>(this.collectionName, id);
    }

    async findMany(filter: Filter<T> = {}, options: FindOptions<T> = {}): Promise<T[]> {
        return this.utils.findMany<T>(this.collectionName, filter, options);
    }

    async updateById(id: string | ObjectId, update: Partial<Omit<T, '_id' | 'createdAt'>>): Promise<boolean> {
        return this.utils.updateById<T>(this.collectionName, id, update);
    }

    async deleteById(id: string | ObjectId): Promise<boolean> {
        return this.utils.deleteById<T>(this.collectionName, id);
    }

    async paginate(filter: Filter<T> = {}, options: PaginationOptions = {}): Promise<PaginationResult<T>> {
        return this.utils.paginate<T>(this.collectionName, filter, options);
    }
}

// Usage example with User repository
interface User extends BaseDocument {
    name: string;
    email: string;
    age: number;
    role?: string;
}

class UserRepository extends BaseRepository<User> {
    constructor(db: Db, client: MongoClient) {
        super('users', db, client);
    }

    async findByEmail(email: string): Promise<User | null> {
        return await this.collection.findOne({ email } as Filter<User>);
    }

    async findByRole(role: string): Promise<User[]> {
        return await this.collection.find({ role } as Filter<User>).toArray();
    }

    async getUserStats(): Promise<{ totalUsers: number; averageAge: number }> {
        const stats = await this.collection.aggregate([
            {
                $group: {
                    _id: null,
                    totalUsers: { $sum: 1 },
                    averageAge: { $avg: '$age' }
                }
            }
        ]).toArray();

        return (stats[0] as { totalUsers: number; averageAge: number }) || { totalUsers: 0, averageAge: 0 };
    }
}

// Usage example
async function mongoExample(): Promise<void> {
    const connectionManager = new ConnectionManager('mongodb://localhost:27017');

    try {
        await connectionManager.connect();
        const db = connectionManager.getDatabase('myapp');
        const client = connectionManager.getClient();
        const utils = connectionManager.getUtils('myapp');

        // Using repository pattern
        const userRepo = new UserRepository(db, client);

        // Create a user
        const user = await userRepo.create({
            name: 'Alice Johnson',
            email: 'alice@example.com',
            age: 30,
            role: 'admin'
        });
        console.log('Created user:', user);

        // Find user by email
        const foundUser = await userRepo.findByEmail('alice@example.com');
        console.log('Found user:', foundUser);

        // Find users with pagination
        const result = await userRepo.paginate({}, {
            page: 1,
            limit: 5,
            sort: { createdAt: -1 }
        });
        console.log('Paginated users:', result);

        // Get user statistics
        const stats = await userRepo.getUserStats();
        console.log('User statistics:', stats);

        // Group users by role using utils
        const roleGroups = await utils.groupBy('users', 'role');
        console.log('Users by role:', roleGroups);

        // Health check
        const health = await utils.healthCheck();
        console.log('Health check:', health);

        // Execute transaction
        await utils.withTransaction(async (_session) => {
            await userRepo.create({
                name: 'Transaction User',
                email: 'trans@example.com',
                age: 25
            });

            // More operations...
            console.log('Transaction completed');
        });

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await connectionManager.disconnect();
    }
}

export {
    MongoUtils,
    ConnectionManager,
    BaseRepository,
    UserRepository,
    User,
    BaseDocument,
    PaginationResult,
    PaginationOptions,
    HealthCheckResult,
    CollectionInfo,
    ConnectionOptions
};