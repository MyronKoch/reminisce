/**
 * Reminisce Initialization
 *
 * Creates and initializes an Reminisce database with optional vector search.
 */

import { Database } from 'bun:sqlite';
import {
  initializeSchema,
  initializeVectorSearch,
  isVectorSearchAvailable,
  getVectorVersion,
} from '@reminisce/storage-sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Options for initializing Reminisce
 */
export interface InitOptions {
  /** Path to the database file */
  path: string;

  /** Whether to enable vector search */
  enableVector?: boolean;

  /** Embedding dimensions for vector search */
  dimensions?: number;

  /** Machine identifier */
  machineId?: string;
}

/**
 * Result of initialization
 */
export interface InitResult {
  /** Whether episodic table was created (vs already existed) */
  episodicCreated: boolean;

  /** Whether semantic table was created (vs already existed) */
  semanticCreated: boolean;

  /** Whether vector search was enabled */
  vectorEnabled: boolean;

  /** Vector search version if enabled */
  vectorVersion: string | null;

  /** Path to the created database */
  path: string;
}

/**
 * Initialize a new Reminisce database
 */
export async function init(options: InitOptions): Promise<InitResult> {
  const { path, enableVector = false, dimensions = 768 } = options;

  // Create directory if it doesn't exist
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Check if database already exists
  const dbExists = existsSync(path);

  // Try to use Homebrew SQLite on macOS for extension support
  if (process.platform === 'darwin' && enableVector) {
    try {
      Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
    } catch {
      try {
        Database.setCustomSQLite('/usr/local/opt/sqlite3/lib/libsqlite3.dylib');
      } catch {
        // Fall through to system SQLite
      }
    }
  }

  // Open/create database
  const db = new Database(path);

  // Check what tables exist before initialization
  const tablesBeforeEpisodic = db.prepare<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='episodic_memories'"
  ).get();

  const tablesBeforeSemantic = db.prepare<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='semantic_memories'"
  ).get();

  // Initialize schema
  initializeSchema(db);

  // Initialize vector search if requested
  let vectorEnabled = false;
  let vectorVersion: string | null = null;

  if (enableVector) {
    try {
      initializeVectorSearch(db, { dimensions });
      vectorEnabled = isVectorSearchAvailable(db);
      vectorVersion = getVectorVersion(db);
    } catch {
      // Vector search not available
      vectorEnabled = false;
    }
  }

  // Close database
  db.close();

  return {
    episodicCreated: !tablesBeforeEpisodic,
    semanticCreated: !tablesBeforeSemantic,
    vectorEnabled,
    vectorVersion,
    path,
  };
}
