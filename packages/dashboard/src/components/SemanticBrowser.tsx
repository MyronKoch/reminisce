import { useState, useEffect } from 'react';
import { reminisceClient } from '../api/reminisce';
import type { SemanticMemory } from '@reminisce/core/types';

export default function SemanticBrowser() {
  const [facts, setFacts] = useState<SemanticMemory[]>([]);
  const [groupedFacts, setGroupedFacts] = useState<Map<string, SemanticMemory[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);

  useEffect(() => {
    loadFacts();
  }, []);

  const loadFacts = async () => {
    try {
      setLoading(true);
      const data = await reminisceClient.getSemanticFacts({ limit: 1000 });
      setFacts(data);

      // Group facts by subject
      const grouped = new Map<string, SemanticMemory[]>();
      data.forEach((fact) => {
        const subject = fact.content.subject || 'Unknown';
        if (!grouped.has(subject)) {
          grouped.set(subject, []);
        }
        grouped.get(subject)!.push(fact);
      });
      setGroupedFacts(grouped);

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load semantic facts');
    } finally {
      setLoading(false);
    }
  };

  const findContradictions = (subjectFacts: SemanticMemory[]) => {
    // Predicates that are inherently multi-valued (lists, not conflicts)
    const MULTI_VALUED_PREDICATES = new Set([
      'has_successful_pattern',
      'has_tool_pattern',
      'has_workflow_pattern',
      'has_preference',
      'prefers',
      'uses',
      'uses_tool',
      'builds',
      'has_skill',
      'has_interest',
      'has_capability',
    ]);

    const predicateMap = new Map<string, SemanticMemory[]>();
    subjectFacts.forEach((fact) => {
      const predicate = fact.content.predicate;
      if (predicate) {
        if (!predicateMap.has(predicate)) {
          predicateMap.set(predicate, []);
        }
        predicateMap.get(predicate)!.push(fact);
      }
    });

    const contradictions: SemanticMemory[][] = [];
    predicateMap.forEach((factsWithSamePredicate, predicate) => {
      // Skip known multi-valued predicates
      if (MULTI_VALUED_PREDICATES.has(predicate)) return;

      if (factsWithSamePredicate.length > 1) {
        const objects = new Set(factsWithSamePredicate.map((f) => f.content.object).filter(Boolean));
        // Skip if too many distinct values — it's a collection, not a conflict
        if (objects.size > 1 && objects.size <= 3) {
          contradictions.push(factsWithSamePredicate);
        }
      }
    });

    return contradictions;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-white/50">Loading semantic facts...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card p-6 border-[#FF453A]/30">
        <h3 className="text-[#FF453A] font-semibold">Error</h3>
        <p className="text-[#FF453A]/80 mt-1">{error}</p>
        <button
          onClick={loadFacts}
          className="mt-4 px-4 py-2 bg-[#FF453A] text-white rounded-lg hover:bg-[#FF453A]/80 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-semibold text-white tracking-tight">Semantic Facts Browser</h2>
        <button
          onClick={loadFacts}
          className="px-4 py-2 bg-[#30D158] text-white rounded-lg font-medium hover:bg-[#3EE066] transition-all hover:shadow-[0_4px_12px_rgba(48,209,88,0.4)]"
        >
          Refresh
        </button>
      </div>

      <div className="glass-card p-5 border-[#30D158]/30">
        <p className="text-sm text-white/70">
          <strong className="text-[#30D158]">Semantic Memory</strong> stores facts and knowledge - the "what" without temporal context.
          Facts are organized as subject-predicate-object triples.
        </p>
      </div>

      {facts.length === 0 ? (
        <div className="text-center py-12 text-white/50">
          No semantic facts found
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Subject List */}
          <div className="lg:col-span-1">
            <div className="glass-card p-4">
              <h3 className="font-semibold text-white mb-4">Subjects ({groupedFacts.size})</h3>
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {Array.from(groupedFacts.keys()).map((subject) => {
                  const subjectFacts = groupedFacts.get(subject)!;
                  const contradictions = findContradictions(subjectFacts);
                  const hasContradictions = contradictions.length > 0;

                  return (
                    <button
                      key={subject}
                      onClick={() => setSelectedSubject(subject)}
                      className={`
                        w-full text-left px-3 py-2 rounded-lg transition-all
                        ${
                          selectedSubject === subject
                            ? 'bg-[#30D158]/20 text-[#30D158] border border-[#30D158]/40'
                            : 'hover:bg-white/5 text-white/80 border border-transparent'
                        }
                      `}
                    >
                      <div className="flex justify-between items-center">
                        <span className="text-sm">{subject}</span>
                        <div className="flex items-center space-x-2">
                          {hasContradictions && (
                            <span className="text-xs bg-[#FF453A] text-white px-2 py-0.5 rounded">
                              ⚠️
                            </span>
                          )}
                          <span className={`text-xs ${selectedSubject === subject ? 'text-[#30D158]/70' : 'text-white/40'}`}>
                            {subjectFacts.length}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Fact Details */}
          <div className="lg:col-span-2">
            {selectedSubject ? (
              <div className="glass-card p-4">
                <h3 className="font-semibold text-white mb-4">
                  Facts about "{selectedSubject}"
                </h3>

                {(() => {
                  const subjectFacts = groupedFacts.get(selectedSubject)!;
                  const contradictions = findContradictions(subjectFacts);

                  return (
                    <>
                      {contradictions.length > 0 && (
                        <div className="mb-4 bg-[#FF453A]/10 border border-[#FF453A]/30 rounded-lg p-3">
                          <h4 className="text-sm font-semibold text-[#FF453A] mb-2">
                            ⚠️ Contradictions Detected
                          </h4>
                          {contradictions.map((group, idx) => (
                            <div key={idx} className="text-xs text-[#FF453A]/80 mb-1">
                              {group.map((f) => (
                                <div key={f.memory_id.id}>
                                  {f.content.predicate}: {f.content.object}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="space-y-3">
                        {subjectFacts.map((fact) => (
                          <div
                            key={fact.memory_id.id}
                            className="border-l-4 border-[#30D158] pl-4 py-2"
                          >
                            <div className="flex items-start justify-between">
                              <div>
                                <p className="text-sm text-white/80 mb-1">
                                  {fact.content.fact}
                                </p>
                                {fact.content.predicate && fact.content.object && (
                                  <p className="text-xs text-white/50">
                                    <span className="font-semibold">{fact.content.predicate}:</span>{' '}
                                    {fact.content.object}
                                  </p>
                                )}
                                <p className="text-xs text-white/40 mt-1">
                                  <span className="px-2 py-0.5 rounded-full bg-[#30D158]/20 text-[#30D158]">
                                    Salience: {fact.salience.current_score.toFixed(2)}
                                  </span>
                                </p>
                              </div>
                              <span className="text-xs text-white/40">
                                {new Date(fact.provenance.last_validated).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="glass-card p-12 text-center text-white/50">
                Select a subject to view facts
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
