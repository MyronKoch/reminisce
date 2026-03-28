import { useState, useEffect } from 'react';
import { reminisceClient } from '../api/reminisce';
import type { WorkingMemoryItem } from '@reminisce/core/types';

export default function WorkingMemoryView() {
  const [items, setItems] = useState<WorkingMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadWorkingMemory();
  }, []);

  const loadWorkingMemory = async () => {
    try {
      setLoading(true);
      const data = await reminisceClient.getWorkingMemory();
      setItems(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load working memory');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-white/50">Loading working memory...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card p-6 border-[#FF453A]/30">
        <h3 className="text-[#FF453A] font-semibold">Error</h3>
        <p className="text-[#FF453A]/80 mt-1">{error}</p>
        <button
          onClick={loadWorkingMemory}
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
        <h2 className="text-2xl font-semibold text-white tracking-tight">Working Memory</h2>
        <button
          onClick={loadWorkingMemory}
          className="px-4 py-2 bg-[#0A84FF] text-white rounded-lg font-medium hover:bg-[#3395FF] transition-all hover:shadow-[0_4px_12px_rgba(10,132,255,0.4)]"
        >
          Refresh
        </button>
      </div>

      <div className="glass-card p-5 border-[#0A84FF]/30">
        <p className="text-sm text-white/70">
          <strong className="text-[#0A84FF]">Working Memory</strong> holds the current context - the most recent and relevant items
          (typically 7 ± 2 items, following Miller's Law). These decay naturally unless consolidated.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-12 text-white/50">
          No items in working memory
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => (
            <div
              key={item.memory_id.id}
              className="glass-card p-4 transition-all hover:translate-y-[-2px] hover:border-[#0A84FF]/40 hover:shadow-lg"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center space-x-3 mb-3">
                    <span className="text-sm font-semibold text-white/60">
                      #{index + 1} - Slot {item.slot}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[#0A84FF]/20 text-[#0A84FF]">
                      Salience: {item.salience.current_score.toFixed(2)}
                    </span>
                  </div>
                  <div className="mb-3">
                    <span className="text-xs px-2 py-1 rounded bg-white/10 text-white/70">
                      {item.content.type}
                    </span>
                  </div>
                  <p className="text-white">
                    {typeof item.content.data === 'string' ? item.content.data : JSON.stringify(item.content.data).slice(0, 200)}
                  </p>
                  {item.content.summary && (
                    <p className="text-sm text-white/50 mt-2 italic">
                      {item.content.summary}
                    </p>
                  )}
                </div>
                <div className="text-xs text-white/40">
                  {new Date(item.provenance.last_validated).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
