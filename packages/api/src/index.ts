/**
 * @reminisce/api - HTTP API Server Package
 *
 * Provides REST endpoints for Reminisce dashboard and external integrations.
 *
 * @example
 * ```typescript
 * import { startServer, createApp } from '@reminisce/api';
 * import { Reminisce } from '@reminisce/orchestrator';
 *
 * const reminisce = new Reminisce({ machineId: 'my-machine' });
 * startServer({ reminisce, port: 3001 });
 * ```
 *
 * @packageDocumentation
 */

export {
  createApp,
  createMultiTenantApp,
  startServer,
  type APIServerConfig,
  type MultiTenantConfig,
  type KnowledgeGraphNode,
  type KnowledgeGraphEdge,
  type KnowledgeGraphData,
} from './server.js';

// Auth exports
export {
  createAuthMiddleware,
  getAuth,
  requireAuth,
  createJWT,
  verifyJWT,
  generateApiKey,
  createTenant,
  createTenantStore,
  type Tenant,
  type AuthContext,
  type AuthConfig,
  type JWTPayload,
} from './auth.js';

// CLI mode: Start server if run directly
const isMainModule = import.meta.main;

if (isMainModule) {
  const { Reminisce } = await import('@reminisce/orchestrator');

  // Check for SQLite storage
  let episodicStore;
  let semanticStore;

  const homedir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const dbPath = process.env.REMINISCE_DB_PATH || `${homedir}/.reminisce/memory.db`;
  const machineId = process.env.REMINISCE_MACHINE_ID || 'reminisce-api';

  try {
    const { SqliteEpisodicStore, SqliteSemanticStore } = await import('@reminisce/storage-sqlite');
    episodicStore = new SqliteEpisodicStore(dbPath, { machineId });
    semanticStore = new SqliteSemanticStore(dbPath, { machineId, sessionId: 'api' });
    console.log(`📁 Using SQLite storage: ${dbPath}`);
  } catch {
    console.log('📦 Using in-memory storage (SQLite not available)');
  }

  const reminisce = new Reminisce({
    machineId,
    episodicStore,
    semanticStore,
  });

  // Start a default session
  reminisce.startSession('api-session');

  const port = parseInt(process.env.PORT || process.env.REMINISCE_API_PORT || '5103');
  const corsOrigins = process.env.REMINISCE_CORS_ORIGINS?.split(',') || ['*'];

  const { startServer } = await import('./server.js');
  startServer({ reminisce, port, corsOrigins });
}
