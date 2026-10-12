import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useWorkspace } from '../state/workspace';
import { useVoice } from '../voice/VoiceProvider';
import { useHubBadge } from '../pages/hub/useHubBadge';

type NavItem = { to: string; icon: string; label: string; end?: boolean; badge?: boolean };
const NAV: NavItem[] = [
  { to: '/', icon: '🏠', label: 'Home', end: true },
  { to: '/chat', icon: '💬', label: 'Chat' },
  { to: '/stock', icon: '📦', label: 'Stock' },
  { to: '/sales', icon: '💳', label: 'Sales' },
  { to: '/hub', icon: '🤝', label: 'Hub', badge: true },
  { to: '/insights', icon: '📊', label: 'Insights' },
];
const EXTRA: NavItem[] = [
  { to: '/customers', icon: '🧾', label: 'Money owed' },
  { to: '/profile', icon: '⚙️', label: 'Profile & settings' },
];

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return <span className="nav-dot" aria-label={`${n} unread`}>{n > 9 ? '9+' : n}</span>;
}

export function AppShell({ children }: { children?: ReactNode }) {
  const { mode, exitDemo, online, queue, business } = useWorkspace();
  const voice = useVoice();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const navType = useNavigationType();
  useEffect(() => {
    if (navType !== 'POP') window.scrollTo(0, 0);
  }, [location.pathname, navType]);
  const unread = useHubBadge();
  const showFab = !['/', '/chat'].includes(location.pathname) && !location.pathname.startsWith('/hub/messages/');
  const pending = queue.filter((q) => q.status !== 'failed').length;
  const failed = queue.filter((q) => q.status === 'failed').length;

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      {mode === 'demo' && (
        <div className="demo-banner" role="note">
          Demo shop — sample data, saved only in this browser tab.{' '}
          <button className="btn-ghost" style={{ background: 'none', border: 0, textDecoration: 'underline', fontWeight: 800, cursor: 'pointer' }}
            onClick={() => { exitDemo(); navigate('/welcome'); }}>Leave demo</button>
        </div>
      )}
      {(!online || pending > 0 || failed > 0) && (
        <div className="offline-banner" role="status" aria-live="polite">
          {!online ? '📡 You are offline. ' : ''}
          {pending > 0 && `${pending} sale${pending === 1 ? '' : 's'} saved on this phone, waiting to sync. `}
          {failed > 0 && <NavLink to="/sales" style={{ color: 'var(--yellow-400)', fontWeight: 700 }}>{failed} need{failed === 1 ? 's' : ''} attention</NavLink>}
          {!online && pending === 0 && failed === 0 && 'Changes need internet.'}
        </div>
      )}
      <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            <span className="avatar avatar-sm" aria-hidden="true">V</span>
            <span className="brand-name side-label">Vendora</span>
          </div>
          <button className="btn btn-yellow side-label" style={{ marginBottom: 8 }} onClick={() => voice.open()}>
            <span aria-hidden="true">🎙️</span> Talk to Vendora
          </button>
          {[...NAV, ...EXTRA].map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end ?? false} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
              <span className="nav-icon" aria-hidden="true">{n.icon}</span>
              <span className="side-label">{n.label}</span>
              {n.badge && unread > 0 && <span className="badge badge-danger side-label" style={{ marginLeft: 'auto' }}>{unread}</span>}
            </NavLink>
          ))}
          <div className="spacer" />
          {business && <div className="side-label xs" style={{ color: 'var(--on-dark-muted)', padding: '0 8px 8px' }}>{business.name}</div>}
          <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? '»' : '« Collapse'}
          </button>
        </nav>
        <main id="main" className="app-main" tabIndex={-1}>
          <div key={location.pathname} className="page-enter">{children ?? <Outlet />}</div>
        </main>
      </div>
      {showFab && (
        <button className="talk-fab" onClick={() => voice.open()} aria-label="Talk to Vendora">
          <span aria-hidden="true">🎙️</span>
        </button>
      )}
      <nav className="bottom-nav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon" aria-hidden="true">{n.icon}</span>
            <span>{n.label}</span>
            {n.badge && <Badge n={unread} />}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
