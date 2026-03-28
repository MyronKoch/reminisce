import { ReactNode, useEffect, useState, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { reminisceClient } from '../api/reminisce';

type ApiStatus = 'connecting' | 'connected' | 'disconnected';

function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>('connecting');

  const check = useCallback(async () => {
    const ok = await reminisceClient.checkHealth();
    setStatus(ok ? 'connected' : 'disconnected');
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [check]);

  return status;
}

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const apiStatus = useApiStatus();

  // Force dark mode for Liquid Glass aesthetic
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const navItems = [
    { path: '/', label: 'Overview', icon: '📊' },
    { path: '/working-memory', label: 'Working Memory', icon: '🧠' },
    { path: '/episodic', label: 'Episodic Timeline', icon: '📅' },
    { path: '/semantic', label: 'Semantic Facts', icon: '📚' },
    { path: '/graph', label: 'Knowledge Graph', icon: '🕸️' },
  ];

  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <header className="glass-card rounded-none border-t-0 border-x-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <h1 className="text-2xl font-semibold text-white tracking-tight">
              Reminisce Dashboard
            </h1>
            <div className="flex items-center space-x-2">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  apiStatus === 'connected'
                    ? 'bg-[#30D158]'
                    : apiStatus === 'connecting'
                    ? 'bg-[#FF9F0A] animate-pulse'
                    : 'bg-[#FF453A]'
                }`}
              />
              <span className={`text-sm ${
                apiStatus === 'connected'
                  ? 'text-[#30D158]/80'
                  : apiStatus === 'connecting'
                  ? 'text-[#FF9F0A]/80'
                  : 'text-[#FF453A]/80'
              }`}>
                {apiStatus === 'connected'
                  ? 'API Connected'
                  : apiStatus === 'connecting'
                  ? 'Connecting...'
                  : `API Offline`}
              </span>
              {apiStatus === 'disconnected' && (
                <span className="text-xs text-white/30 font-mono">
                  {reminisceClient.getBaseUrl()}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="glass-card rounded-none border-t-0 border-x-0 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-1">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center space-x-2 py-3 px-4 text-sm font-medium transition-all rounded-t-lg
                    ${
                      isActive
                        ? 'bg-[#0A84FF]/20 text-[#0A84FF] border-b-2 border-[#0A84FF]'
                        : 'text-white/50 hover:text-white/80 hover:bg-white/5 border-b-2 border-transparent'
                    }
                  `}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
