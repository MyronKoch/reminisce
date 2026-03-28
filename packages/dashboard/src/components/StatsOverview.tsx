import { useState, useEffect } from 'react';
import { reminisceClient } from '../api/reminisce';
import type { ReminisceStats } from '../api/reminisce';

const START_CMD = 'cd packages/api && bun run dev';

export default function StatsOverview() {
  const [stats, setStats] = useState<ReminisceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadStats = async () => {
    try {
      setLoading(true);
      const data = await reminisceClient.getStats();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  };

  const handleTriggerConsolidation = async () => {
    try {
      await reminisceClient.triggerConsolidation();
      await loadStats();
    } catch (err) {
      alert('Failed to trigger consolidation: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-white/50">Loading stats...</div>
      </div>
    );
  }

  if (error) {
    const isConnectionError = error === 'Failed to fetch' || error.includes('fetch');
    return (
      <div className="space-y-4">
        <div className="glass-card p-6 border-[#FF453A]/30">
          <div className="flex items-center space-x-3 mb-3">
            <span className="inline-block w-3 h-3 rounded-full bg-[#FF453A]" />
            <h3 className="text-[#FF453A] font-semibold text-lg">
              {isConnectionError ? 'API Server Not Running' : 'Error'}
            </h3>
          </div>
          {isConnectionError ? (
            <div className="space-y-4">
              <p className="text-white/70">
                The dashboard can't reach the Reminisce API at{' '}
                <code className="text-[#FF9F0A] font-mono text-sm bg-white/5 px-2 py-0.5 rounded">
                  {reminisceClient.getBaseUrl()}
                </code>
              </p>
              <div className="bg-black/40 rounded-lg p-4 border border-white/10">
                <p className="text-white/50 text-xs mb-2 font-medium uppercase tracking-wider">Start the API server</p>
                <div className="flex items-center justify-between">
                  <code className="text-[#30D158] font-mono text-sm">{START_CMD}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(START_CMD)}
                    className="ml-4 px-3 py-1.5 text-xs glass-btn rounded-md hover:border-[#0A84FF] transition-colors"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <button
                onClick={loadStats}
                className="px-5 py-2.5 bg-[#0A84FF] text-white rounded-lg font-medium hover:bg-[#3395FF] transition-all hover:shadow-[0_4px_12px_rgba(10,132,255,0.4)]"
              >
                Retry Connection
              </button>
            </div>
          ) : (
            <>
              <p className="text-[#FF453A]/80 mt-1">{error}</p>
              <button
                onClick={loadStats}
                className="mt-4 px-4 py-2 bg-[#FF453A] text-white rounded-lg hover:bg-[#FF453A]/80 transition-colors"
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-semibold text-white tracking-tight">Reminisce Overview</h2>
        <button
          onClick={loadStats}
          className="glass-btn px-4 py-2 rounded-lg text-sm font-medium"
        >
          Refresh
        </button>
      </div>

      <div className="glass-card p-6 border-[#0A84FF]/20">
        <h3 className="text-lg font-semibold text-white mb-2">
          Reminisce
        </h3>
        <p className="text-white/70">
          A cognitive science-inspired memory architecture for AI agents. Mimics human memory
          with working memory, episodic memory, and semantic memory layers.
        </p>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Working Memory"
            value={stats.workingMemorySize ?? stats.workingMemoryCount ?? 0}
            icon="🧠"
            color="blue"
            description="Current context items"
          />
          <StatCard
            title="Episodic Memory"
            value={stats.pendingEpisodes ?? stats.episodicMemoryCount ?? 0}
            icon="📅"
            color="purple"
            description="Stored episodes"
          />
          <StatCard
            title="Semantic Facts"
            value={stats.totalFacts ?? stats.semanticFactCount ?? 0}
            icon="📚"
            color="green"
            description="Knowledge base size"
          />
          <StatCard
            title="Sessions"
            value={stats.sessions ?? stats.consolidationsToday ?? 0}
            icon="🔄"
            color="cyan"
            description="Active sessions"
          />
        </div>
      )}

      {/* System Status */}
      {stats && (
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold text-white mb-4">System Status</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-white/60">Working Memory Capacity:</span>
              <span className="font-mono text-sm text-white">
                {stats.workingMemorySize ?? 0} / {stats.workingMemoryCapacity ?? 7}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-white/60">Consolidated Episodes:</span>
              <span className="font-mono text-sm text-white">
                {stats.consolidatedEpisodes ?? 0}
              </span>
            </div>
            <div className="pt-4 border-t border-white/10">
              <button
                onClick={handleTriggerConsolidation}
                className="w-full px-4 py-2.5 bg-[#0A84FF] text-white rounded-lg font-medium hover:bg-[#3395FF] transition-all hover:shadow-[0_4px_12px_rgba(10,132,255,0.4)]"
              >
                Trigger Consolidation
              </button>
              <p className="text-xs text-white/40 mt-2">
                Manually trigger the consolidation process to move working memory to long-term storage
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Quick Links */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <QuickLinkCard
          title="Working Memory"
          description="View and manage current context"
          link="/working-memory"
          icon="🧠"
        />
        <QuickLinkCard
          title="Episodic Timeline"
          description="Browse stored episodes"
          link="/episodic"
          icon="📅"
        />
        <QuickLinkCard
          title="Semantic Browser"
          description="Explore knowledge facts"
          link="/semantic"
          icon="📚"
        />
        <QuickLinkCard
          title="Knowledge Graph"
          description="Visualize connections"
          link="/graph"
          icon="🕸️"
        />
      </div>
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: number;
  icon: string;
  color: 'blue' | 'purple' | 'green' | 'cyan';
  description: string;
}

function StatCard({ title, value, icon, color, description }: StatCardProps) {
  const colorMap = {
    blue: { accent: '#0A84FF', bg: 'rgba(10, 132, 255, 0.15)', border: 'rgba(10, 132, 255, 0.3)' },
    purple: { accent: '#BF5AF2', bg: 'rgba(191, 90, 242, 0.15)', border: 'rgba(191, 90, 242, 0.3)' },
    green: { accent: '#30D158', bg: 'rgba(48, 209, 88, 0.15)', border: 'rgba(48, 209, 88, 0.3)' },
    cyan: { accent: '#64D2FF', bg: 'rgba(100, 210, 255, 0.15)', border: 'rgba(100, 210, 255, 0.3)' },
  };

  const colors = colorMap[color];

  return (
    <div
      className="glass-card p-5 transition-all hover:translate-y-[-2px] hover:shadow-lg"
      style={{ borderColor: colors.border }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-2xl">{icon}</span>
        <span className="text-3xl font-bold" style={{ color: colors.accent }}>{value}</span>
      </div>
      <h3 className="font-semibold text-white mb-1">{title}</h3>
      <p className="text-sm text-white/50">{description}</p>
    </div>
  );
}

interface QuickLinkCardProps {
  title: string;
  description: string;
  link: string;
  icon: string;
}

function QuickLinkCard({ title, description, link, icon }: QuickLinkCardProps) {
  return (
    <a
      href={link}
      className="glass-card p-5 transition-all hover:translate-y-[-2px] hover:border-[#0A84FF]/40 hover:shadow-lg block"
    >
      <div className="flex items-start space-x-4">
        <span className="text-3xl">{icon}</span>
        <div>
          <h3 className="font-semibold text-white mb-1">{title}</h3>
          <p className="text-sm text-white/50">{description}</p>
        </div>
      </div>
    </a>
  );
}
