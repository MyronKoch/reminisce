/**
 * Suppression Policies
 *
 * Provides mechanisms to block or filter memories based on:
 * - Topic patterns (regex matching)
 * - Session IDs (specific sessions)
 * - Entity names (specific entities to exclude)
 * - Time ranges (memories from specific periods)
 *
 * Supports both hard blocking (never store) and soft blocking (store but don't consolidate).
 */

import type { WorkingMemoryItem, EpisodicMemory, SemanticMemory } from '@reminisce/core';

/**
 * Types of suppression actions
 */
export type SuppressionAction = 'block' | 'redact' | 'skip_consolidation' | 'low_priority';

/**
 * Suppression rule definition
 */
export interface SuppressionRule {
  /** Unique identifier for the rule */
  id: string;

  /** Human-readable name */
  name: string;

  /** Whether the rule is active */
  enabled: boolean;

  /** Type of suppression to apply */
  action: SuppressionAction;

  /** Optional expiration timestamp */
  expiresAt?: Date;

  /** Match criteria (at least one must be specified) */
  criteria: SuppressionCriteria;

  /** Optional reason for suppression */
  reason?: string;
}

/**
 * Criteria for matching memories to suppress
 */
export interface SuppressionCriteria {
  /** Regex patterns to match against content/summaries */
  topicPatterns?: string[];

  /** Specific session IDs to suppress */
  sessionIds?: string[];

  /** Entity names to suppress */
  entities?: string[];

  /** Machine IDs to suppress */
  machineIds?: string[];

  /** Tags that trigger suppression */
  tags?: string[];

  /** Time range for suppression */
  timeRange?: {
    start?: Date;
    end?: Date;
  };
}

/**
 * Result of checking suppression
 */
export interface SuppressionCheckResult {
  /** Whether the memory should be suppressed */
  suppressed: boolean;

  /** Which rules matched */
  matchedRules: SuppressionRule[];

  /** The most restrictive action to apply */
  action: SuppressionAction | null;

  /** Combined reasons */
  reasons: string[];
}

/**
 * Suppression policy manager
 */
export class SuppressionManager {
  private rules: Map<string, SuppressionRule> = new Map();
  private compiledPatterns: Map<string, RegExp[]> = new Map();

  /**
   * Add a suppression rule
   */
  addRule(rule: SuppressionRule): void {
    this.rules.set(rule.id, rule);
    this.compilePatterns(rule);
  }

  /**
   * Remove a suppression rule
   */
  removeRule(ruleId: string): boolean {
    this.compiledPatterns.delete(ruleId);
    return this.rules.delete(ruleId);
  }

  /**
   * Enable or disable a rule
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    rule.enabled = enabled;
    return true;
  }

  /**
   * Get all rules
   */
  getRules(): SuppressionRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get a specific rule
   */
  getRule(ruleId: string): SuppressionRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Check if a working memory item should be suppressed
   */
  checkWorkingMemory(item: WorkingMemoryItem): SuppressionCheckResult {
    const text = this.extractText(item);
    return this.check({
      text,
      sessionId: item.memory_id.source_session,
      entities: [],
      machineId: item.memory_id.source_machine,
      tags: item.tags ?? [],
      timestamp: item.memory_id.created_at,
    });
  }

  /**
   * Check if an episodic memory should be suppressed
   */
  checkEpisodicMemory(episode: EpisodicMemory): SuppressionCheckResult {
    const text = `${episode.content.event} ${episode.content.summary}`;
    return this.check({
      text,
      sessionId: episode.session_id,
      entities: episode.content.entities,
      machineId: episode.memory_id.source_machine,
      tags: episode.tags ?? [],
      timestamp: episode.memory_id.created_at,
    });
  }

  /**
   * Check if a semantic memory should be suppressed
   */
  checkSemanticMemory(fact: SemanticMemory): SuppressionCheckResult {
    const text = fact.content.fact;
    const entities: string[] = [];
    if (fact.content.subject) entities.push(fact.content.subject);
    if (fact.content.object) entities.push(fact.content.object);

    return this.check({
      text,
      entities,
      machineId: fact.memory_id.source_machine,
      tags: fact.tags ?? [],
      timestamp: fact.memory_id.created_at,
    });
  }

  /**
   * Core check logic
   */
  private check(context: {
    text: string;
    sessionId?: string;
    entities: string[];
    machineId: string;
    tags: string[];
    timestamp: Date;
  }): SuppressionCheckResult {
    const matchedRules: SuppressionRule[] = [];
    const reasons: string[] = [];

    const now = new Date();

    for (const rule of this.rules.values()) {
      // Skip disabled rules
      if (!rule.enabled) continue;

      // Skip expired rules
      if (rule.expiresAt && rule.expiresAt < now) continue;

      // Check if rule matches
      if (this.matchesCriteria(rule, context)) {
        matchedRules.push(rule);
        if (rule.reason) {
          reasons.push(rule.reason);
        }
      }
    }

    // Determine most restrictive action
    const action = this.getMostRestrictiveAction(matchedRules);

    return {
      suppressed: matchedRules.length > 0,
      matchedRules,
      action,
      reasons,
    };
  }

  /**
   * Check if a rule's criteria match the context
   */
  private matchesCriteria(
    rule: SuppressionRule,
    context: {
      text: string;
      sessionId?: string;
      entities: string[];
      machineId: string;
      tags: string[];
      timestamp: Date;
    }
  ): boolean {
    const criteria = rule.criteria;

    // Check topic patterns
    if (criteria.topicPatterns && criteria.topicPatterns.length > 0) {
      const patterns = this.compiledPatterns.get(rule.id) ?? [];
      const matchesPattern = patterns.some((p) => p.test(context.text));
      if (!matchesPattern) return false;
    }

    // Check session IDs
    if (criteria.sessionIds && criteria.sessionIds.length > 0) {
      if (!context.sessionId || !criteria.sessionIds.includes(context.sessionId)) {
        return false;
      }
    }

    // Check entities
    if (criteria.entities && criteria.entities.length > 0) {
      const hasMatchingEntity = context.entities.some((e) =>
        criteria.entities!.some((ce) => e.toLowerCase().includes(ce.toLowerCase()))
      );
      if (!hasMatchingEntity) return false;
    }

    // Check machine IDs
    if (criteria.machineIds && criteria.machineIds.length > 0) {
      if (!criteria.machineIds.includes(context.machineId)) {
        return false;
      }
    }

    // Check tags
    if (criteria.tags && criteria.tags.length > 0) {
      const hasMatchingTag = context.tags.some((t) => criteria.tags!.includes(t));
      if (!hasMatchingTag) return false;
    }

    // Check time range
    if (criteria.timeRange) {
      if (criteria.timeRange.start && context.timestamp < criteria.timeRange.start) {
        return false;
      }
      if (criteria.timeRange.end && context.timestamp > criteria.timeRange.end) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compile regex patterns for a rule
   */
  private compilePatterns(rule: SuppressionRule): void {
    if (rule.criteria.topicPatterns && rule.criteria.topicPatterns.length > 0) {
      try {
        const patterns = rule.criteria.topicPatterns.map((p) => new RegExp(p, 'i'));
        this.compiledPatterns.set(rule.id, patterns);
      } catch {
        console.warn(`Invalid regex pattern in rule ${rule.id}`);
        this.compiledPatterns.set(rule.id, []);
      }
    }
  }

  /**
   * Determine the most restrictive action from matched rules
   */
  private getMostRestrictiveAction(rules: SuppressionRule[]): SuppressionAction | null {
    if (rules.length === 0) return null;

    // Priority order: block > redact > skip_consolidation > low_priority
    const priority: SuppressionAction[] = ['block', 'redact', 'skip_consolidation', 'low_priority'];

    for (const action of priority) {
      if (rules.some((r) => r.action === action)) {
        return action;
      }
    }

    return rules[0]!.action;
  }

  /**
   * Extract text content from a working memory item
   */
  private extractText(item: WorkingMemoryItem): string {
    const parts: string[] = [];

    if (item.content.summary) {
      parts.push(item.content.summary);
    }

    if (typeof item.content.data === 'string') {
      parts.push(item.content.data);
    } else if (item.content.data && typeof item.content.data === 'object') {
      parts.push(JSON.stringify(item.content.data));
    }

    return parts.join(' ');
  }

  /**
   * Clear all rules
   */
  clear(): void {
    this.rules.clear();
    this.compiledPatterns.clear();
  }

  /**
   * Export rules to JSON
   */
  exportRules(): string {
    return JSON.stringify(Array.from(this.rules.values()), null, 2);
  }

  /**
   * Import rules from JSON
   */
  importRules(json: string): number {
    const rules = JSON.parse(json) as SuppressionRule[];
    let count = 0;

    for (const rule of rules) {
      // Restore Date objects
      if (rule.expiresAt) {
        rule.expiresAt = new Date(rule.expiresAt);
      }
      if (rule.criteria.timeRange?.start) {
        rule.criteria.timeRange.start = new Date(rule.criteria.timeRange.start);
      }
      if (rule.criteria.timeRange?.end) {
        rule.criteria.timeRange.end = new Date(rule.criteria.timeRange.end);
      }

      this.addRule(rule);
      count++;
    }

    return count;
  }
}

/**
 * Create a rule to block sensitive topics
 */
export function createTopicBlockRule(
  id: string,
  name: string,
  patterns: string[],
  options: { action?: SuppressionAction; reason?: string; expiresAt?: Date } = {}
): SuppressionRule {
  const rule: SuppressionRule = {
    id,
    name,
    enabled: true,
    action: options.action ?? 'block',
    criteria: {
      topicPatterns: patterns,
    },
  };
  if (options.expiresAt !== undefined) rule.expiresAt = options.expiresAt;
  if (options.reason !== undefined) rule.reason = options.reason;
  return rule;
}

/**
 * Create a rule to block specific sessions
 */
export function createSessionBlockRule(
  id: string,
  name: string,
  sessionIds: string[],
  options: { action?: SuppressionAction; reason?: string; expiresAt?: Date } = {}
): SuppressionRule {
  const rule: SuppressionRule = {
    id,
    name,
    enabled: true,
    action: options.action ?? 'skip_consolidation',
    criteria: {
      sessionIds,
    },
  };
  if (options.expiresAt !== undefined) rule.expiresAt = options.expiresAt;
  if (options.reason !== undefined) rule.reason = options.reason;
  return rule;
}

/**
 * Create a rule to redact specific entities
 */
export function createEntityRedactRule(
  id: string,
  name: string,
  entities: string[],
  options: { action?: SuppressionAction; reason?: string; expiresAt?: Date } = {}
): SuppressionRule {
  const rule: SuppressionRule = {
    id,
    name,
    enabled: true,
    action: options.action ?? 'redact',
    criteria: {
      entities,
    },
  };
  if (options.expiresAt !== undefined) rule.expiresAt = options.expiresAt;
  if (options.reason !== undefined) rule.reason = options.reason;
  return rule;
}
