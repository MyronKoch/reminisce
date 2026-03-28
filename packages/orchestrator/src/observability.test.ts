/**
 * Tests for Reminisce Observability
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { ObservabilityCollector } from './observability.js';
import { Reminisce } from './reminisce.js';

describe('ObservabilityCollector', () => {
  let collector: ObservabilityCollector;

  beforeEach(() => {
    collector = new ObservabilityCollector({ maxEvents: 100 });
  });

  describe('recordOperation', () => {
    test('records an operation', () => {
      collector.recordOperation('remember', 'working', 5.5, true);
      const events = collector.getRecentEvents(1);
      expect(events.length).toBe(1);
      expect(events[0].operation).toBe('remember');
      expect(events[0].layer).toBe('working');
      expect(events[0].latencyMs).toBe(5.5);
      expect(events[0].success).toBe(true);
    });

    test('records metadata', () => {
      collector.recordOperation('search', 'all', 10, true, { hits: 5 });
      const events = collector.getRecentEvents(1);
      expect(events[0].metadata).toEqual({ hits: 5 });
    });

    test('implements ring buffer', () => {
      const smallCollector = new ObservabilityCollector({ maxEvents: 3 });

      smallCollector.recordOperation('remember', 'working', 1, true);
      smallCollector.recordOperation('search', 'all', 2, true);
      smallCollector.recordOperation('consolidate', 'all', 3, true);
      smallCollector.recordOperation('store_fact', 'semantic', 4, true);

      const events = smallCollector.getRecentEvents(10);
      expect(events.length).toBe(3);
      // Most recent should be first
      expect(events[0].operation).toBe('store_fact');
    });
  });

  describe('recordSalience', () => {
    test('tracks salience values', () => {
      collector.recordSalience(0.5);
      collector.recordSalience(0.8);
      collector.recordSalience(0.3);

      const metrics = collector.getAggregatedMetrics();
      const nonZeroBuckets = metrics.salienceDistribution.filter((b) => b.count > 0);
      expect(nonZeroBuckets.length).toBeGreaterThan(0);
    });

    test('bounds values to [0, 1]', () => {
      collector.recordSalience(-0.5);
      collector.recordSalience(1.5);

      const metrics = collector.getAggregatedMetrics();
      const distribution = metrics.salienceDistribution;
      // -0.5 should be 0 (first bucket), 1.5 should be 1 (last bucket)
      expect(distribution[0].count).toBeGreaterThanOrEqual(1); // 0.0-0.1
      expect(distribution[9].count).toBeGreaterThanOrEqual(1); // 0.9-1.0
    });
  });

  describe('recordConsolidation', () => {
    test('tracks consolidation stats', () => {
      collector.recordConsolidation(10, 5);
      collector.recordConsolidation(8, 3);

      const metrics = collector.getAggregatedMetrics();
      expect(metrics.consolidation.episodesProcessed).toBe(18);
      expect(metrics.consolidation.factsExtracted).toBe(8);
      expect(metrics.consolidation.avgExtractionRatio).toBeCloseTo(8 / 18, 2);
    });
  });

  describe('getAggregatedMetrics', () => {
    test('computes latency percentiles', () => {
      // Add 100 operations with varying latencies
      for (let i = 0; i < 100; i++) {
        collector.recordOperation('remember', 'working', i + 1, true);
      }

      const metrics = collector.getAggregatedMetrics();
      const remember = metrics.operations.remember!;

      expect(remember.count).toBe(100);
      expect(remember.avgLatencyMs).toBe(50.5); // (1+100)/2
      expect(remember.p50LatencyMs).toBe(50);
      expect(remember.p95LatencyMs).toBe(95);
      expect(remember.p99LatencyMs).toBe(99);
    });

    test('tracks error count', () => {
      collector.recordOperation('search', 'all', 5, true);
      collector.recordOperation('search', 'all', 10, false);
      collector.recordOperation('search', 'all', 15, true);

      const metrics = collector.getAggregatedMetrics();
      expect(metrics.operations.search!.count).toBe(3);
      expect(metrics.operations.search!.errorCount).toBe(1);
    });

    test('aggregates layer activity', () => {
      collector.recordOperation('remember', 'working', 5, true);
      collector.recordOperation('search', 'all', 10, true);
      collector.recordOperation('store_fact', 'semantic', 15, true);

      const metrics = collector.getAggregatedMetrics();
      expect(metrics.layerActivity.working?.writes).toBe(1);
      expect(metrics.layerActivity.all?.reads).toBe(1);
      expect(metrics.layerActivity.semantic?.writes).toBe(1);
    });
  });

  describe('timeOperation', () => {
    test('times async operations', async () => {
      const result = await collector.timeOperation(
        'search',
        'all',
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'result';
        }
      );

      expect(result).toBe('result');
      const events = collector.getRecentEvents(1);
      expect(events[0].operation).toBe('search');
      expect(events[0].latencyMs).toBeGreaterThan(5);
      expect(events[0].success).toBe(true);
    });

    test('records errors', async () => {
      await expect(
        collector.timeOperation('search', 'all', async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      const events = collector.getRecentEvents(1);
      expect(events[0].success).toBe(false);
      expect(events[0].metadata?.error).toBe('Test error');
    });
  });

  describe('reset', () => {
    test('clears all data', () => {
      collector.recordOperation('remember', 'working', 5, true);
      collector.recordSalience(0.5);
      collector.recordConsolidation(10, 5);

      collector.reset();

      expect(collector.getRecentEvents(10)).toEqual([]);
      const metrics = collector.getAggregatedMetrics();
      expect(Object.keys(metrics.operations)).toEqual([]);
      expect(metrics.consolidation.episodesProcessed).toBe(0);
    });
  });
});

describe('Reminisce with Observability', () => {
  let reminisce: Reminisce;

  beforeEach(() => {
    reminisce = new Reminisce({ machineId: 'test-obs' });
    reminisce.startSession('test-session');
  });

  test('observability is enabled by default', () => {
    expect(reminisce.observability).not.toBeNull();
  });

  test('can disable observability', () => {
    const noObsReminisce = new Reminisce({
      machineId: 'test-no-obs',
      enableObservability: false,
    });
    expect(noObsReminisce.observability).toBeNull();
  });

  test('records remember operations', async () => {
    await reminisce.remember({
      type: 'context',
      data: { test: true },
      summary: 'Test item',
    });

    const events = reminisce.observability!.getRecentEvents(1);
    expect(events[0].operation).toBe('remember');
    expect(events[0].layer).toBe('working');
    expect(events[0].success).toBe(true);
  });

  test('records search operations', async () => {
    await reminisce.search({ text: 'test' });

    const events = reminisce.observability!.getRecentEvents(1);
    expect(events[0].operation).toBe('search');
    expect(events[0].layer).toBe('all');
    expect(events[0].metadata).toHaveProperty('workingHits');
  });

  test('records storeFact operations', async () => {
    await reminisce.storeFact({
      fact: 'Test fact',
      subject: 'test',
      predicate: 'is',
      object: 'working',
      sourceEpisodeIds: [],
    });

    const events = reminisce.observability!.getRecentEvents(1);
    expect(events[0].operation).toBe('store_fact');
    expect(events[0].layer).toBe('semantic');
  });

  test('records consolidation with stats', async () => {
    await reminisce.consolidate();

    const events = reminisce.observability!.getRecentEvents(1);
    expect(events[0].operation).toBe('consolidate');
    expect(events[0].metadata).toHaveProperty('episodesProcessed');
    expect(events[0].metadata).toHaveProperty('factsExtracted');
  });

  test('tracks salience distribution', async () => {
    await reminisce.remember({ type: 'context', data: { a: 1 }, signals: { reward_signal: 0.9 } });
    await reminisce.remember({ type: 'context', data: { b: 2 }, signals: { reward_signal: 0.1 } });

    const metrics = reminisce.observability!.getAggregatedMetrics();
    const nonZeroBuckets = metrics.salienceDistribution.filter((b) => b.count > 0);
    expect(nonZeroBuckets.length).toBeGreaterThan(0);
  });
});
