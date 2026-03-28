import { describe, it, expect } from 'bun:test';
import {
  runBenchmarks,
  runAllBenchmarks,
  formatBenchmarkReport,
  type BenchmarkConfig,
} from './benchmark.js';

describe('Benchmark Suite', () => {
  describe('runBenchmarks', () => {
    it('should run salience benchmarks', () => {
      const config: BenchmarkConfig = {
        name: 'salience-test',
        suites: ['salience'],
      };

      const report = runBenchmarks(config);

      expect(report.name).toBe('salience-test');
      expect(report.suites.salience).toBeDefined();
      expect(report.suites.salience.results.length).toBeGreaterThan(0);
      expect(report.passRate).toBeGreaterThanOrEqual(0);
      expect(report.passRate).toBeLessThanOrEqual(1);
    });

    it('should run retrieval benchmarks', () => {
      const config: BenchmarkConfig = {
        name: 'retrieval-test',
        suites: ['retrieval'],
      };

      const report = runBenchmarks(config);

      expect(report.suites.retrieval).toBeDefined();
      expect(report.suites.retrieval.results.length).toBe(2);
    });

    it('should run consolidation benchmarks', () => {
      const config: BenchmarkConfig = {
        name: 'consolidation-test',
        suites: ['consolidation'],
      };

      const report = runBenchmarks(config);

      expect(report.suites.consolidation).toBeDefined();
      expect(report.suites.consolidation.results.length).toBe(2);
    });

    it('should run integration benchmarks', () => {
      const config: BenchmarkConfig = {
        name: 'integration-test',
        suites: ['integration'],
      };

      const report = runBenchmarks(config);

      expect(report.suites.integration).toBeDefined();
      expect(report.suites.integration.results.length).toBe(2);
    });

    it('should run multiple suites', () => {
      const config: BenchmarkConfig = {
        name: 'multi-suite-test',
        suites: ['salience', 'retrieval'],
      };

      const report = runBenchmarks(config);

      expect(report.suites.salience).toBeDefined();
      expect(report.suites.retrieval).toBeDefined();
      expect(report.overallMaxScore).toBeGreaterThan(0);
    });
  });

  describe('runAllBenchmarks', () => {
    it('should run all benchmark suites', () => {
      const report = runAllBenchmarks();

      expect(report.suites.salience).toBeDefined();
      expect(report.suites.retrieval).toBeDefined();
      expect(report.suites.consolidation).toBeDefined();
      expect(report.suites.integration).toBeDefined();
    });

    it('should calculate correct totals', () => {
      const report = runAllBenchmarks();

      const suiteScores = Object.values(report.suites)
        .filter(Boolean)
        .reduce((sum, s) => sum + s!.score, 0);

      const suiteMaxScores = Object.values(report.suites)
        .filter(Boolean)
        .reduce((sum, s) => sum + s!.maxScore, 0);

      expect(report.overallScore).toBe(suiteScores);
      expect(report.overallMaxScore).toBe(suiteMaxScores);
    });
  });

  describe('formatBenchmarkReport', () => {
    it('should format report as string', () => {
      const report = runBenchmarks({
        name: 'format-test',
        suites: ['salience'],
      });

      const formatted = formatBenchmarkReport(report);

      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('format-test');
      expect(formatted).toContain('SALIENCE');
      expect(formatted).toContain('Pass Rate');
    });

    it('should include pass/fail indicators', () => {
      const report = runAllBenchmarks();
      const formatted = formatBenchmarkReport(report);

      // Should have either ✓ or ✗
      const hasPassIndicator = formatted.includes('✓');
      const hasFailIndicator = formatted.includes('✗');

      expect(hasPassIndicator || hasFailIndicator).toBe(true);
    });
  });

  describe('individual benchmarks', () => {
    it('should correctly identify blocked memories', () => {
      const report = runBenchmarks({
        name: 'blocked-test',
        suites: ['salience'],
      });

      const blockedResult = report.suites.salience.results.find(
        r => r.name === 'blocked_memory'
      );

      expect(blockedResult).toBeDefined();
      expect(blockedResult!.passed).toBe(true);
      const details = blockedResult!.details as { salienceScore: number };
      expect(details.salienceScore).toBeLessThan(0); // Blocked returns -1
    });

    it('should correctly identify pinned memory boost', () => {
      const report = runBenchmarks({
        name: 'pinned-test',
        suites: ['salience'],
      });

      const pinnedResult = report.suites.salience.results.find(
        r => r.name === 'pinned_boost'
      );

      expect(pinnedResult).toBeDefined();
      expect(pinnedResult!.passed).toBe(true);
      const details = pinnedResult!.details as { boost: number };
      expect(details.boost).toBeGreaterThanOrEqual(0.2); // Default boost is 0.3
    });
  });
});
