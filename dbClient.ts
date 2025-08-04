import { MongoClient, Document, Db, Collection, ObjectId, Filter, UpdateFilter, FindOptions, ClientSession } from 'mongodb';

// Environment configuration
interface DatabaseConfig {
    url: string;
    dbName: string;
    options?: {
        maxPoolSize?: number;
        serverSelectionTimeoutMS?: number;
        socketTimeoutMS?: number;
    };
}

// Base document interface
interface BaseDocument {
    _id?: ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
}

// Pagination interfaces
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

// Database connection manager
class DatabaseManager {
    private client: MongoClient | null = null;
    private db: Db | null = null;
    private config: DatabaseConfig;

    constructor(config: DatabaseConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        try {
            this.client = new MongoClient(this.config.url, this.config.options);
            await this.client.connect();
            this.db = this.client.db(this.config.dbName);
            console.log('Connected to MongoDB');
        } catch (error) {
            console.error('Connection error:', error);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.db = null;
            console.log('Disconnected from MongoDB');
        }
    }

    getDatabase(): Db {
        if (!this.db) {
            throw new Error('Database not connected');
        }
        return this.db;
    }

    getClient(): MongoClient {
        if (!this.client) {
            throw new Error('Database not connected');
        }
        return this.client;
    }

    collection<T extends Document = any>(name: string): Collection<T> {
        if (!this.db) {
            throw new Error('Database not connected');
        }
        return this.db.collection<T>(name);
    }
}

// Generic repository class
class Repository<T extends BaseDocument> {
    protected collection: Collection<T>;
    protected db: Db;
    protected client: MongoClient;

    constructor(
        private collectionName: string,
        database: Db,
        client: MongoClient
    ) {
        this.collection = database.collection<T>(collectionName);
        this.db = database;
        this.client = client;
    }

    // Utility methods
    static isValidObjectId(id: string): boolean {
        return ObjectId.isValid(id);
    }

    static toObjectId(id: string | ObjectId): ObjectId {
        if (id instanceof ObjectId) return id;
        try {
            return new ObjectId(id);
        } catch (error) {
            throw new Error(`Invalid ObjectId: ${id}`);
        }
    }

    // CRUD operations
    async create(document: Omit<T, '_id' | 'createdAt' | 'updatedAt'>): Promise<T> {
        const now = new Date();
        const docWithTimestamps = {
            ...document,
            createdAt: now,
            updatedAt: now
        };

        const result = await this.collection.insertOne(docWithTimestamps as any);

        return {
            _id: result.insertedId,
            ...docWithTimestamps
        } as T;
    }

    async findById(id: string | ObjectId): Promise<T | null> {
        const objectId = Repository.toObjectId(id);
        return await this.collection.findOne({ _id: objectId } as any) as T | null;
    }

    async findOne(filter: Filter<T>): Promise<T | null> {
        return await this.collection.findOne(filter) as T | null;
    }

    async find(filter: Filter<T> = {}, options: FindOptions<T> = {}): Promise<T[]> {
        const cursor = this.collection.find(filter, options);
        const results = await cursor.toArray();
        return results as T[];
    }

    async updateById(
        id: string | ObjectId,
        update: Partial<Omit<T, '_id' | 'createdAt'>>
    ): Promise<boolean> {
        const objectId = Repository.toObjectId(id);

        const updateDoc = {
            $set: {
                ...update,
                updatedAt: new Date()
            }
        };

        const result = await this.collection.updateOne(
            { _id: objectId } as any,
            updateDoc as any
        );

        if (result.matchedCount === 0) {
            throw new Error(`Document with id ${id} not found`);
        }

        return result.modifiedCount > 0;
    }

    async updateOne(filter: Filter<T>, update: UpdateFilter<T>): Promise<boolean> {
        const result = await this.collection.updateOne(filter, update);
        return result.modifiedCount > 0;
    }

    async updateMany(filter: Filter<T>, update: UpdateFilter<T>): Promise<number> {
        const result = await this.collection.updateMany(filter, update);
        return result.modifiedCount;
    }

    async deleteById(id: string | ObjectId): Promise<boolean> {
        const objectId = Repository.toObjectId(id);
        const result = await this.collection.deleteOne({ _id: objectId } as any);

        if (result.deletedCount === 0) {
            throw new Error(`Document with id ${id} not found`);
        }

        return true;
    }

    async deleteOne(filter: Filter<T>): Promise<boolean> {
        const result = await this.collection.deleteOne(filter);
        return result.deletedCount > 0;
    }

    async deleteMany(filter: Filter<T>): Promise<number> {
        const result = await this.collection.deleteMany(filter);
        return result.deletedCount;
    }

    async count(filter: Filter<T> = {}): Promise<number> {
        return await this.collection.countDocuments(filter);
    }

    // Pagination
    async paginate(
        filter: Filter<T> = {},
        options: PaginationOptions = {}
    ): Promise<PaginationResult<T>> {
        const {
            page = 1,
            limit = 10,
            sort = { _id: -1 },
            projection = {}
        } = options;

        const skip = (page - 1) * limit;

        const [data, total] = await Promise.all([
            this.collection
                .find(filter, { projection })
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .toArray(),
            this.collection.countDocuments(filter)
        ]);

        return {
            data: data as T[],
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

    // Aggregation
    async aggregate(pipeline: any[]): Promise<any[]> {
        return await this.collection.aggregate(pipeline).toArray();
    }

    // Transaction support
    async withTransaction<TResult>(
        operation: (session: ClientSession) => Promise<TResult>
    ): Promise<TResult> {
        const session = this.client.startSession();

        try {
            return await session.withTransaction(async () => {
                return await operation(session);
            });
        } finally {
            await session.endSession();
        }
    }

    // Index management
    async createIndex(keys: Record<string, 1 | -1>, options: any = {}): Promise<string> {
        return await this.collection.createIndex(keys, options);
    }

    async getIndexes(): Promise<any[]> {
        return await this.collection.indexes();
    }

    // Collection statistics
    async getCollectionStats(): Promise<{
        name: string;
        documentCount: number;
        indexes: any[];
        storageSize?: number;
        avgObjSize?: number;
    }> {
        try {
            const [stats, indexes, count] = await Promise.all([
                this.db.command({ collStats: this.collectionName }).catch(() => null),
                this.collection.indexes(),
                this.collection.countDocuments({})
            ]);

            const collStats = stats as any;

            return {
                name: this.collectionName,
                documentCount: count,
                indexes,
                storageSize: collStats?.storageSize || 0,
                avgObjSize: collStats?.avgObjSize || 0
            };
        } catch (error) {
            return {
                name: this.collectionName,
                documentCount: await this.collection.countDocuments({}),
                indexes: await this.collection.indexes(),
                storageSize: 0,
                avgObjSize: 0
            };
        }
    }

    // Bulk operations
    async insertMany(documents: Omit<T, '_id' | 'createdAt' | 'updatedAt'>[]): Promise<ObjectId[]> {
        const now = new Date();
        const docsWithTimestamps = documents.map(doc => ({
            ...doc,
            createdAt: now,
            updatedAt: now
        }));

        const result = await this.collection.insertMany(docsWithTimestamps as any);
        return Object.values(result.insertedIds);
    }

    async bulkWrite(operations: any[]): Promise<any> {
        return await this.collection.bulkWrite(operations);
    }
}

// Example User interface and repository
interface User extends BaseDocument {
    name: string;
    email: string;
    age: number;
    role?: string;
    status?: string;
}

class UserRepository extends Repository<User> {
    constructor(database: Db, client: MongoClient) {
        super('users', database, client);
    }

    async findByEmail(email: string): Promise<User | null> {
        return await this.findOne({ email });
    }

    async findByRole(role: string): Promise<User[]> {
        return await this.find({ role });
    }

    async findAdults(): Promise<User[]> {
        return await this.find({ age: { $gte: 18 } });
    }

    async getUserStats(): Promise<{ totalUsers: number; averageAge: number }> {
        const pipeline = [
            {
                $group: {
                    _id: null,
                    totalUsers: { $sum: 1 },
                    averageAge: { $avg: '$age' }
                }
            }
        ];

        const result = await this.aggregate(pipeline);
        return result[0] || { totalUsers: 0, averageAge: 0 };
    }

    async getUsersByAgeRange(minAge: number, maxAge: number): Promise<User[]> {
        return await this.find({
            age: { $gte: minAge, $lte: maxAge }
        });
    }

    async updateUserStatus(userId: string | ObjectId, status: string): Promise<boolean> {
        return await this.updateById(userId, { status });
    }
}

// Configuration helper
function createDatabaseConfig(): DatabaseConfig {
    return {
        url: process.env['MONGODB_URI'] || 'mongodb://localhost:27017',
        dbName: process.env['MONGODB_DB_NAME'] || 'myapp',
        options: {
            maxPoolSize: parseInt(process.env['MONGODB_MAX_POOL_SIZE'] || '10'),
            serverSelectionTimeoutMS: parseInt(process.env['MONGODB_SERVER_SELECTION_TIMEOUT'] || '5000'),
            socketTimeoutMS: parseInt(process.env['MONGODB_SOCKET_TIMEOUT'] || '45000'),
        }
    };
}

// Usage example
async function example(): Promise<void> {
    const config = createDatabaseConfig();
    const dbManager = new DatabaseManager(config);

    try {
        await dbManager.connect();

        const database = dbManager.getDatabase();
        const client = dbManager.getClient();

        // Create user repository
        const userRepo = new UserRepository(database, client);

        // Create user
        const user = await userRepo.create({
            name: 'John Doe',
            email: 'john@example.com',
            age: 30,
            role: 'admin'
        });
        console.log('Created user:', user);

        // Find user by email
        const foundUser = await userRepo.findByEmail('john@example.com');
        console.log('Found user:', foundUser);

        // Get paginated users
        const paginatedUsers = await userRepo.paginate({}, {
            page: 1,
            limit: 10,
            sort: { createdAt: -1 }
        });
        console.log('Paginated users:', paginatedUsers);

        // Get statistics
        const stats = await userRepo.getUserStats();
        console.log('User stats:', stats);

        // Transaction example
        await userRepo.withTransaction(async (session) => {
            await userRepo.create({
                name: 'Transaction User',
                email: 'trans@example.com',
                age: 25
            });
            console.log('Transaction completed');
        });

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await dbManager.disconnect();
    }
}

export {
    DatabaseManager,
    Repository,
    UserRepository,
    User,
    BaseDocument,
    DatabaseConfig,
    PaginationResult,
    PaginationOptions,
    createDatabaseConfig
};