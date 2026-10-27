import { useEffect, useState } from 'react';
import { api, clearToken, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Articles from './pages/Articles.jsx';
import Sedes from './pages/Sedes.jsx';
import Publish from './pages/Publish.jsx';
import Status from './pages/Status.jsx';
import Users from './pages/Users.jsx';

const PAGES = [
  { key: 'articles', label: 'Artículos', permission: 'articles.read', component: Articles },
  { key: 'sedes', label: 'Sedes y balanzas', permission: 'sedes.read', component: Sedes },
  { key: 'publish', label: 'Publicar', permission: 'deployments.create', component: Publish },
  { key: 'status', label: 'Estado', permission: 'status.read', component: Status },
  { key: 'users', label: 'Usuarios', permission: 'users.manage', component: Users },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(Boolean(getToken()));
  const [page, setPage] = useState('articles');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener('balanza:logout', onLogout);
    return () => window.removeEventListener('balanza:logout', onLogout);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setBooting(false);
      return;
    }
    api('/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => clearToken())
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <div className="boot">
        <div className="spinner" />
        <p className="muted">Cargando…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <Login
        onLogin={(token, nextUser) => {
          setToken(token);
          setUser(nextUser);
        }}
      />
    );
  }

  const allowed = PAGES.filter((candidate) => user.permissions.includes(candidate.permission));
  const active = allowed.find((candidate) => candidate.key === page) ?? allowed[0];
  const Page = active?.component;

  const go = (key) => {
    setPage(key);
    setMenuOpen(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menú">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="topbar-title">{active?.label ?? 'BalanzaWeb'}</span>
        <span className="topbar-user" title={user.name}>
          {user.name.split(' ')[0]}
        </span>
      </header>

      {menuOpen && <div className="overlay" onClick={() => setMenuOpen(false)} />}

      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="auth-logo small">BW</div>
          <div>
            <h1>BalanzaWeb</h1>
            <div className="who">
              {user.name}
              <br />
              {user.roles.map((role) => role.name).join(' · ')}
            </div>
          </div>
        </div>

        <nav>
          {allowed.map((candidate) => (
            <button
              key={candidate.key}
              className={active?.key === candidate.key ? 'active' : ''}
              onClick={() => go(candidate.key)}
            >
              {candidate.label}
            </button>
          ))}
        </nav>

        <button
          className="ghost logout"
          onClick={async () => {
            try {
              await api('/auth/logout', { method: 'POST' });
            } catch {
              /* the session may already be gone */
            }
            clearToken();
            setUser(null);
          }}
        >
          Cerrar sesión
        </button>
      </aside>

      <main className="main">{Page ? <Page user={user} /> : <p>No tenés permisos asignados.</p>}</main>
    </div>
  );
}
