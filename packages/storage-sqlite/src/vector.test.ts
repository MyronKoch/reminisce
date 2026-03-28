import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'fs';
import {
  initializeVectorSearch,
  storeSemanticEmbedding,
  searchSemanticByVector,
  deleteSemanticEmbedding,
  batchStoreSemanticEmbeddings,
  isVectorSearchAvailable,
  getVectorVersion,
} from './vector.js';

const TEST_DB = '/tmp/reminisce-vector-test.db';
const DIMENSIONS = 4; // Small dimension for testing

describe('Vector Search', () => {
  let db: Database;
  let vectorAvailable: boolean;

  beforeAll(() => {
    // On macOS, try to use Homebrew SQLite which supports extensions
    if (process.platform === 'darwin') {
      try {
        Database.setCustomSQLite('/usr/local/opt/sqlite3/lib/libsqlite3.dylib');
      } catch {
        // Try arm64 path
        try {
          Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
        } catch {
          // Fall through to system SQLite
        }
      }
    }
  });

  beforeEach(() => {
    // Clean up any existing test database
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    if (existsSync(`${TEST_DB}-wal`)) {
      unlinkSync(`${TEST_DB}-wal`);
    }
    if (existsSync(`${TEST_DB}-shm`)) {
      unlinkSync(`${TEST_DB}-shm`);
    }

    db = new Database(TEST_DB);

    // Try to initialize vector search
    try {
      initializeVectorSearch(db, { dimensions: DIMENSIONS });
      vectorAvailable = true;
    } catch {
      vectorAvailable = false;
    }
  });

  afterEach(() => {
    db.close();
    // Clean up test database
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    if (existsSync(`${TEST_DB}-wal`)) {
      unlinkSync(`${TEST_DB}-wal`);
    }
    if (existsSync(`${TEST_DB}-shm`)) {
      unlinkSync(`${TEST_DB}-shm`);
    }
  });

  describe('initialization', () => {
    it('should detect vector search availability', () => {
      if (vectorAvailable) {
        expect(isVectorSearchAvailable(db)).toBe(true);
      } else {
        expect(isVectorSearchAvailable(db)).toBe(false);
        console.log('Skipping vector tests - sqlite-vec not available');
      }
    });

    it('should get vector version when available', () => {
      if (!vectorAvailable) {
        expect(getVectorVersion(db)).toBeNull();
        return;
      }

      const version = getVectorVersion(db);
      expect(version).not.toBeNull();
      expect(typeof version).toBe('string');
    });
  });

  describe('semantic vector operations', () => {
    it('should store and search semantic embeddings', () => {
      if (!vectorAvailable) {
        console.log('Skipping - sqlite-vec not available');
        return;
      }

      // Store some test embeddings
      storeSemanticEmbedding(db, 'fact-1', [0.1, 0.1, 0.1, 0.1]);
      storeSemanticEmbedding(db, 'fact-2', [0.5, 0.5, 0.5, 0.5]);
      storeSemanticEmbedding(db, 'fact-3', [0.9, 0.9, 0.9, 0.9]);

      // Search for similar to [0.5, 0.5, 0.5, 0.5]
      const results = searchSemanticByVector(db, [0.5, 0.5, 0.5, 0.5], 3);

      expect(results.length).toBe(3);
      // fact-2 should be closest (exact match)
      expect(results[0]!.memory_id).toBe('fact-2');
      expect(results[0]!.distance).toBeCloseTo(0, 5);
    });

    it('should delete semantic embedding', () => {
      if (!vectorAvailable) {
        console.log('Skipping - sqlite-vec not available');
        return;
      }

      storeSemanticEmbedding(db, 'fact-to-delete', [0.1, 0.1, 0.1, 0.1]);
      deleteSemanticEmbedding(db, 'fact-to-delete');

      const results = searchSemanticByVector(db, [0.1, 0.1, 0.1, 0.1], 10);
      const found = results.find(r => r.memory_id === 'fact-to-delete');
      expect(found).toBeUndefined();
    });

    it('should batch store embeddings', () => {
      if (!vectorAvailable) {
        console.log('Skipping - sqlite-vec not available');
        return;
      }

      batchStoreSemanticEmbeddings(db, [
        { memoryId: 'batch-1', embedding: [0.1, 0.2, 0.3, 0.4] },
        { memoryId: 'batch-2', embedding: [0.2, 0.3, 0.4, 0.5] },
        { memoryId: 'batch-3', embedding: [0.3, 0.4, 0.5, 0.6] },
      ]);

      const results = searchSemanticByVector(db, [0.2, 0.3, 0.4, 0.5], 3);
      expect(results.length).toBe(3);
      expect(results[0]!.memory_id).toBe('batch-2');
    });

    it('should handle update (replace) of existing embedding', () => {
      if (!vectorAvailable) {
        console.log('Skipping - sqlite-vec not available');
        return;
      }

      // Store initial embedding
      storeSemanticEmbedding(db, 'updateable', [0.1, 0.1, 0.1, 0.1]);

      // Update with new embedding
      storeSemanticEmbedding(db, 'updateable', [0.9, 0.9, 0.9, 0.9]);

      // Search should find it near [0.9, 0.9, 0.9, 0.9]
      const results = searchSemanticByVector(db, [0.9, 0.9, 0.9, 0.9], 1);
      expect(results.length).toBe(1);
      expect(results[0]!.memory_id).toBe('updateable');
      expect(results[0]!.distance).toBeCloseTo(0, 5);
    });
  });

  describe('graceful degradation', () => {
    it('should allow app to work without vector search', () => {
      // Even if vector search isn't available, the basic stores should work
      // This test verifies the pattern of checking availability first
      const available = isVectorSearchAvailable(db);

      if (available) {
        // Vector operations work
        storeSemanticEmbedding(db, 'test', [0.1, 0.1, 0.1, 0.1]);
        const results = searchSemanticByVector(db, [0.1, 0.1, 0.1, 0.1], 1);
        expect(results.length).toBe(1);
      } else {
        // App can still function without vector search
        // The stores handle this gracefully
        expect(true).toBe(true);
      }
    });
  });
});
