/**
 * Reminisce API Client
 *
 * Connects to the Reminisce via:
 * - Direct HTTP API (if Reminisce exposes REST endpoints)
 * - MCP server (via proxy or direct connection)
 *
 * TODO: Configure based on your deployment setup
 */

const API_BASE_URL = import.meta.env.VITE_REMINISCE_API_URL || '';

// Type imports from @reminisce/core
import type {
  WorkingMemoryItem,
  EpisodicMemory,
  SemanticMemory,
} from '@reminisce/core/types';

interface ReminisceStats {
  // API returns these
  sessions?: number;
  workingMemorySize?: number;
  workingMemoryCapacity?: number;
  pendingEpisodes?: number;
  consolidatedEpisodes?: number;
  totalFacts?: number;
  lowConfidenceFacts?: number;
  // Legacy names (for backwards compat)
  workingMemoryCount?: number;
  episodicMemoryCount?: number;
  semanticFactCount?: number;
  consolidationsToday?: number;
  lastConsolidation?: string;
}

interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: 'entity' | 'fact' | 'episode';
  metadata?: Record<string, unknown>;
}

interface KnowledgeGraphEdge {
  from: string;
  to: string;
  label: string;
  type: string;
}

interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

class ReminisceClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  // Helper for API requests
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    return response.json();
  }

  // Working Memory
  async getWorkingMemory(): Promise<WorkingMemoryItem[]> {
    const res = await this.request<{ items: WorkingMemoryItem[] }>('/api/memory/working');
    return res.items || [];
  }

  async addToWorkingMemory(content: string, context?: string): Promise<WorkingMemoryItem> {
    return this.request<WorkingMemoryItem>('/api/memory/working', {
      method: 'POST',
      body: JSON.stringify({ content, context }),
    });
  }

  // Episodic Memory
  async getEpisodicMemories(filters?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<EpisodicMemory[]> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.limit) params.append('limit', filters.limit.toString());

    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{ items: EpisodicMemory[] }>(`/api/memory/episodic${query}`);
    return res.items || [];
  }

  async getEpisodicMemory(id: string): Promise<EpisodicMemory> {
    return this.request<EpisodicMemory>(`/api/memory/episodic/${id}`);
  }

  // Semantic Memory
  async getSemanticFacts(filters?: {
    subject?: string;
    predicate?: string;
    limit?: number;
  }): Promise<SemanticMemory[]> {
    const params = new URLSearchParams();
    if (filters?.subject) params.append('subject', filters.subject);
    if (filters?.predicate) params.append('predicate', filters.predicate);
    if (filters?.limit) params.append('limit', filters.limit.toString());

    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{ items: SemanticMemory[] }>(`/api/memory/semantic${query}`);
    return res.items || [];
  }

  async getSemanticFactsBySubject(subject: string): Promise<SemanticMemory[]> {
    const res = await this.request<{ items: SemanticMemory[] }>(`/api/memory/semantic/subject/${encodeURIComponent(subject)}`);
    return res.items || [];
  }

  // Knowledge Graph
  async getKnowledgeGraph(): Promise<KnowledgeGraphData> {
    return this.request<KnowledgeGraphData>('/api/graph');
  }

  // Stats
  async getStats(): Promise<ReminisceStats> {
    return this.request<ReminisceStats>('/api/stats');
  }

  // Health check
  async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // Search
  async search(query: string): Promise<{
    working: WorkingMemoryItem[];
    episodic: EpisodicMemory[];
    semantic: SemanticMemory[];
  }> {
    return this.request(`/api/search?q=${encodeURIComponent(query)}`);
  }

  // Trigger consolidation manually (if supported)
  async triggerConsolidation(): Promise<{ success: boolean; message: string }> {
    return this.request('/api/consolidate', {
      method: 'POST',
    });
  }
}

// Export singleton instance
export const reminisceClient = new ReminisceClient();

// Export types
export type {
  ReminisceStats,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
  KnowledgeGraphData,
};
