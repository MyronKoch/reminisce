/**
 * Reminisce Observability - Metrics and Instrumentation
 *
 * In-memory metrics collection with optional export to external systems.
 * Tracks latency, hit rates, salience distributions, and consolidation stats.
 */

/**
 * Memory operation types for tracking
 */
export type OperationType =
  | 'remember'
  | 'search'
  | 'consolidate'
  | 'overflow'
  | 'store_fact'
  | 'record_episode'
  | 'forget';

/**
 * Memory layer for context
 */
export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'all';

/**
 * Single metric event
 */
export interface MetricEvent {
  timestamp: Date;
  operation: OperationType;
  layer: MemoryLayer;
  latencyMs: number;
  success: boolean;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Salience distribution bucket
 */
export interface SalienceBucket {
  range: string; // e.g., "0.0-0.1", "0.1-0.2", etc.
  count: number;
}

/**
 * Aggregated metrics for a time window
 */
export interface AggregatedMetrics {
  windowStart: Date;
  windowEnd: Date;
  operations: {
    [key in OperationType]?: {
      count: number;
      avgLatencyMs: number;
      p50LatencyMs: number;
      p95LatencyMs: number;
      p99LatencyMs: number;
      errorCount: number;
    };
  };
  layerActivity: {
    [key in MemoryLayer]?: {
      reads: number;
      writes: number;
    };
  };
  salienceDistribution: SalienceBucket[];
  consolidation: {
    episodesProcessed: number;
    factsExtracted: number;
    avgExtractionRatio: number;
  };
}

/**
 * Configuration for metrics collection
 */
export interface ObservabilityConfig {
  /** Max events to keep in memory (ring buffer) */
  maxEvents: number;
  /** Aggregation window in milliseconds */
  aggregationWindowMs: number;
  /** Whether to track salience distributions */
  trackSalienceDistribution: boolean;
  /** Custom export handler */
  exporter?: (metrics: AggregatedMetrics) => Promise<void>;
  /** Export interval in milliseconds (0 to disable) */
  exportIntervalMs: number;
}

const DEFAULT_CONFIG: ObservabilityConfig = {
  maxEvents: 1000,
  aggregationWindowMs: 60_000, // 1 minute
  trackSalienceDistribution: true,
  exportIntervalMs: 0, // Disabled by default
};

/**
 * Reminisce Observability Collector
 */
export class ObservabilityCollector {
  private config: ObservabilityConfig;
  private events: MetricEvent[] = [];
  private eventIndex = 0; // For ring buffer
  private salienceValues: number[] = [];
  private consolidationStats = {
    episodesProcessed: 0,
    factsExtracted: 0,
  };
  private exportTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<ObservabilityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Start export timer if configured
    if (this.config.exportIntervalMs > 0 && this.config.exporter) {
      this.exportTimer = setInterval(() => {
        this.exportMetrics();
      }, this.config.exportIntervalMs);
    }
  }

  /**
   * Record an operation metric
   */
  recordOperation(
    operation: OperationType,
    layer: MemoryLayer,
    latencyMs: number,
    success: boolean = true,
    metadata?: Record<string, unknown>
  ): void {
    const event: MetricEvent = {
      timestamp: new Date(),
      operation,
      layer,
      latencyMs,
      success,
      metadata,
    };

    // Ring buffer implementation
    if (this.events.length < this.config.maxEvents) {
      this.events.push(event);
    } else {
      this.events[this.eventIndex] = event;
      this.eventIndex = (this.eventIndex + 1) % this.config.maxEvents;
    }
  }

  /**
   * Record a salience value for distribution tracking
   */
  recordSalience(score: number): void {
    if (!this.config.trackSalienceDistribution) return;

    // Keep limited history
    if (this.salienceValues.length >= this.config.maxEvents) {
      this.salienceValues.shift();
    }
    this.salienceValues.push(Math.max(0, Math.min(1, score)));
  }

  /**
   * Record consolidation activity
   */
  recordConsolidation(episodesProcessed: number, factsExtracted: number): void {
    this.consolidationStats.episodesProcessed += episodesProcessed;
    this.consolidationStats.factsExtracted += factsExtracted;
  }

  /**
   * Convenience method to time an async operation
   */
  async timeOperation<T>(
    operation: OperationType,
    layer: MemoryLayer,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.recordOperation(operation, layer, performance.now() - start, true, metadata);
      return result;
    } catch (error) {
      this.recordOperation(operation, layer, performance.now() - start, false, {
        ...metadata,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Get aggregated metrics for a time window
   */
  getAggregatedMetrics(windowMs: number = this.config.aggregationWindowMs): AggregatedMetrics {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    // Filter events within window
    const windowEvents = this.events.filter((e) => e.timestamp >= windowStart);

    // Aggregate by operation
    const operations: AggregatedMetrics['operations'] = {};
    const operationLatencies: Record<string, number[]> = {};

    for (const event of windowEvents) {
      if (!operations[event.operation]) {
        operations[event.operation] = {
          count: 0,
          avgLatencyMs: 0,
          p50LatencyMs: 0,
          p95LatencyMs: 0,
          p99LatencyMs: 0,
          errorCount: 0,
        };
        operationLatencies[event.operation] = [];
      }

      operations[event.operation]!.count++;
      operationLatencies[event.operation]!.push(event.latencyMs);
      if (!event.success) {
        operations[event.operation]!.errorCount++;
      }
    }

    // Calculate latency percentiles
    for (const [op, latencies] of Object.entries(operationLatencies)) {
      latencies.sort((a, b) => a - b);
      const stats = operations[op as OperationType]!;
      stats.avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      stats.p50LatencyMs = this.percentile(latencies, 0.5);
      stats.p95LatencyMs = this.percentile(latencies, 0.95);
      stats.p99LatencyMs = this.percentile(latencies, 0.99);
    }

    // Aggregate by layer
    const layerActivity: AggregatedMetrics['layerActivity'] = {};
    for (const event of windowEvents) {
      if (!layerActivity[event.layer]) {
        layerActivity[event.layer] = { reads: 0, writes: 0 };
      }
      if (['search'].includes(event.operation)) {
        layerActivity[event.layer]!.reads++;
      } else {
        layerActivity[event.layer]!.writes++;
      }
    }

    // Salience distribution
    const salienceDistribution = this.computeSalienceDistribution();

    // Consolidation stats
    const consolidation = {
      episodesProcessed: this.consolidationStats.episodesProcessed,
      factsExtracted: this.consolidationStats.factsExtracted,
      avgExtractionRatio:
        this.consolidationStats.episodesProcessed > 0
          ? this.consolidationStats.factsExtracted / this.consolidationStats.episodesProcessed
          : 0,
    };

    return {
      windowStart,
      windowEnd: now,
      operations,
      layerActivity,
      salienceDistribution,
      consolidation,
    };
  }

  /**
   * Get recent events (for debugging/streaming)
   */
  getRecentEvents(limit: number = 100): MetricEvent[] {
    // Get most recent events in order
    const sorted = [...this.events].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
    return sorted.slice(0, limit);
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.events = [];
    this.eventIndex = 0;
    this.salienceValues = [];
    this.consolidationStats = { episodesProcessed: 0, factsExtracted: 0 };
  }

  /**
   * Stop the collector (cleanup)
   */
  stop(): void {
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
    }
  }

  /**
   * Export metrics using configured exporter
   */
  private async exportMetrics(): Promise<void> {
    if (!this.config.exporter) return;

    try {
      const metrics = this.getAggregatedMetrics();
      await this.config.exporter(metrics);
    } catch (error) {
      console.error('Failed to export metrics:', error);
    }
  }

  /**
   * Compute percentile from sorted array
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)]!;
  }

  /**
   * Compute salience distribution buckets
   */
  private computeSalienceDistribution(): SalienceBucket[] {
    const buckets: SalienceBucket[] = [];
    const bucketSize = 0.1;

    for (let i = 0; i < 10; i++) {
      const lower = i * bucketSize;
      const upper = (i + 1) * bucketSize;
      const range = `${lower.toFixed(1)}-${upper.toFixed(1)}`;
      const count = this.salienceValues.filter((v) => v >= lower && v < upper).length;
      buckets.push({ range, count });
    }

    // Handle exactly 1.0
    const bucket1 = buckets.find((b) => b.range === '0.9-1.0');
    if (bucket1) {
      bucket1.count += this.salienceValues.filter((v) => v === 1.0).length;
    }

    return buckets;
  }
}

/**
 * Create a Prometheus-compatible metrics exporter
 */
export function createPrometheusExporter(endpoint: string): (metrics: AggregatedMetrics) => Promise<void> {
  return async (metrics: AggregatedMetrics) => {
    const lines: string[] = [];

    // Operation metrics
    for (const [op, stats] of Object.entries(metrics.operations)) {
      if (!stats) continue;
      lines.push(`reminisce_operation_count{operation="${op}"} ${stats.count}`);
      lines.push(`reminisce_operation_latency_avg{operation="${op}"} ${stats.avgLatencyMs}`);
      lines.push(`reminisce_operation_latency_p50{operation="${op}"} ${stats.p50LatencyMs}`);
      lines.push(`reminisce_operation_latency_p95{operation="${op}"} ${stats.p95LatencyMs}`);
      lines.push(`reminisce_operation_latency_p99{operation="${op}"} ${stats.p99LatencyMs}`);
      lines.push(`reminisce_operation_errors{operation="${op}"} ${stats.errorCount}`);
    }

    // Layer metrics
    for (const [layer, activity] of Object.entries(metrics.layerActivity)) {
      if (!activity) continue;
      lines.push(`reminisce_layer_reads{layer="${layer}"} ${activity.reads}`);
      lines.push(`reminisce_layer_writes{layer="${layer}"} ${activity.writes}`);
    }

    // Salience distribution
    for (const bucket of metrics.salienceDistribution) {
      lines.push(`reminisce_salience_distribution{range="${bucket.range}"} ${bucket.count}`);
    }

    // Consolidation
    lines.push(`reminisce_consolidation_episodes ${metrics.consolidation.episodesProcessed}`);
    lines.push(`reminisce_consolidation_facts ${metrics.consolidation.factsExtracted}`);

    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: lines.join('\n'),
    });
  };
}
