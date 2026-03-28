import { useState, useEffect } from 'react';
import { reminisceClient } from '../api/reminisce';
import type { EpisodicMemory } from '@reminisce/core/types';

export default function EpisodicTimeline() {
  const [episodes, setEpisodes] = useState<EpisodicMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadEpisodes();
  }, []);

  const loadEpisodes = async () => {
    try {
      setLoading(true);
      const data = await reminisceClient.getEpisodicMemories({ limit: 50 });
      setEpisodes(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load episodic memories');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-white/50">Loading episodic timeline...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card p-6 border-[#FF453A]/30">
        <h3 className="text-[#FF453A] font-semibold">Error</h3>
        <p className="text-[#FF453A]/80 mt-1">{error}</p>
        <button
          onClick={loadEpisodes}
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
        <h2 className="text-2xl font-semibold text-white tracking-tight">Episodic Timeline</h2>
        <button
          onClick={loadEpisodes}
          className="px-4 py-2 bg-[#BF5AF2] text-white rounded-lg font-medium hover:bg-[#D17DF5] transition-all hover:shadow-[0_4px_12px_rgba(191,90,242,0.4)]"
        >
          Refresh
        </button>
      </div>

      <div className="glass-card p-5 border-[#BF5AF2]/30">
        <p className="text-sm text-white/70">
          <strong className="text-[#BF5AF2]">Episodic Memory</strong> stores events with temporal context - the "when" and "where".
          These are personal experiences that happened at specific times.
        </p>
      </div>

      {episodes.length === 0 ? (
        <div className="text-center py-12 text-white/50">
          No episodic memories found
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-white/20" />

          <div className="space-y-6">
            {episodes.map((episode) => (
              <div key={episode.memory_id.id} className="relative pl-16">
                {/* Timeline dot */}
                <div className="absolute left-6 w-5 h-5 bg-[#BF5AF2] rounded-full border-4 border-black shadow-[0_0_8px_rgba(191,90,242,0.5)]" />

                <div className="glass-card p-4 transition-all hover:translate-y-[-2px] hover:border-[#BF5AF2]/40 hover:shadow-lg">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-semibold text-white">{episode.content.event}</h3>
                    <span className="text-xs text-white/40">
                      {new Date(episode.started_at).toLocaleString()}
                    </span>
                  </div>

                  <p className="text-white/80 mb-3">{episode.content.summary}</p>

                  {episode.content.entities && episode.content.entities.length > 0 && (
                    <div className="text-sm text-white/60 bg-white/5 p-2 rounded-lg mb-3">
                      <strong>Entities:</strong> {episode.content.entities.join(', ')}
                    </div>
                  )}

                  <div className="flex items-center space-x-4 text-xs text-white/40">
                    <span className="px-2 py-0.5 rounded-full bg-[#BF5AF2]/20 text-[#BF5AF2]">
                      Salience: {episode.salience.current_score.toFixed(2)}
                    </span>
                    {episode.content.valence !== undefined && (
                      <span>Valence: {episode.content.valence.toFixed(2)}</span>
                    )}
                    {episode.consolidated && (
                      <span className="text-[#30D158]">✓ Consolidated</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
