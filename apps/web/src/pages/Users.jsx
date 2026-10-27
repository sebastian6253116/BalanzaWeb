import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Users({ user: currentUser }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [form, setForm] = useState({ name: '', username: '', password: '', roles: ['viewer'] });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', username: '', active: true });
  const [passwordFor, setPasswordFor] = useState(null);
  const [newPassword, setNewPassword] = useState('');

  async function load() {
    const [usersData, rolesData] = await Promise.all([api('/users'), api('/roles')]);
    setUsers(usersData.users);
    setRoles(rolesData.roles);
    setPermissions(rolesData.permissions);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function createUser(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/users', { method: 'POST', body: form });
      setNotice(`Usuario "${form.username}" creado.`);
      setForm({ name: '', username: '', password: '', roles: ['viewer'] });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleRole(user, roleKey) {
    const next = user.roles.includes(roleKey)
      ? user.roles.filter((key) => key !== roleKey)
      : [...user.roles, roleKey];
    if (next.length === 0) {
      setError('El usuario debe tener al menos un rol.');
      return;
    }
    setError(null);
    try {
      await api(`/users/${user.id}/roles`, { method: 'PUT', body: { roles: next } });
      setNotice(`Roles de "${user.username}" actualizados.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit(user) {
    setEditing(user);
    setEditForm({ name: user.name, username: user.username, active: Boolean(user.active) });
    setPasswordFor(null);
    setError(null);
    setNotice(null);
  }

  async function saveEdit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/users/${editing.id}`, { method: 'PATCH', body: editForm });
      setNotice(`Usuario "${editForm.username}" actualizado.`);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function startPassword(user) {
    setPasswordFor(user);
    setNewPassword('');
    setEditing(null);
    setError(null);
    setNotice(null);
  }

  async function changePassword(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/users/${passwordFor.id}/password`, { method: 'PUT', body: { password: newPassword } });
      setNotice(`Contraseña de "${passwordFor.username}" actualizada.`);
      setPasswordFor(null);
      setNewPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(user) {
    if (!window.confirm(`¿Eliminar al usuario "${user.username}"? Esta acción no se puede deshacer.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/users/${user.id}`, { method: 'DELETE' });
      setNotice(`Usuario "${user.username}" eliminado.`);
      if (editing?.id === user.id) setEditing(null);
      if (passwordFor?.id === user.id) setPasswordFor(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const sections = [...new Set(permissions.map((permission) => permission.section))];

  return (
    <section>
      <h2>Usuarios y permisos</h2>
      <div className="sub">Cada sección de la web depende de un permiso; un rol agrupa permisos</div>

      {notice && <div className="alert info">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Usuario</th>
              <th>Roles</th>
              <th>Estado</th>
              <th>Último ingreso</th>
              <th className="actions-col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.name}</td>
                <td className="mono">{user.username}</td>
                <td>
                  <div className="pill-list">
                    {roles.map((role) => (
                      <button
                        key={role.key}
                        type="button"
                        className={user.roles.includes(role.key) ? '' : 'ghost'}
                        style={{ padding: '5px 11px', fontSize: 12 }}
                        onClick={() => toggleRole(user, role.key)}
                        title={`Alternar rol ${role.name}`}
                      >
                        {role.name}
                      </button>
                    ))}
                  </div>
                </td>
                <td>
                  {user.active ? <span className="badge ok">activo</span> : <span className="badge muted">inactivo</span>}
                </td>
                <td className="muted">
                  {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'nunca'}
                </td>
                <td className="actions-col">
                  <div className="desk-actions">
                    <button className="btn-sm" onClick={() => startEdit(user)}>
                      Editar
                    </button>
                    <button className="btn-sm ghost" onClick={() => startPassword(user)}>
                      Clave
                    </button>
                    {currentUser?.id !== user.id && (
                      <button className="btn-sm danger" disabled={busy} onClick={() => removeUser(user)}>
                        Eliminar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="panel">
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Editar usuario</h3>
          <form onSubmit={saveEdit}>
            <div className="grid3">
              <div>
                <label htmlFor="edit-name">Nombre</label>
                <input
                  id="edit-name"
                  value={editForm.name}
                  onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                  required
                />
              </div>
              <div>
                <label htmlFor="edit-username">Usuario</label>
                <input
                  id="edit-username"
                  value={editForm.username}
                  onChange={(event) => setEditForm({ ...editForm, username: event.target.value })}
                  pattern="[A-Za-z0-9._\-]{3,32}"
                  title="3 a 32 caracteres: letras, números, punto, guion o guion bajo"
                  autoCapitalize="none"
                  spellCheck="false"
                  required
                />
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22 }}>
                  <input
                    type="checkbox"
                    checked={editForm.active}
                    onChange={(event) => setEditForm({ ...editForm, active: event.target.checked })}
                  />
                  Activo
                </label>
              </div>
            </div>

            <div className="actions">
              <button type="button" className="ghost" onClick={() => setEditing(null)}>
                Cancelar
              </button>
              <button type="submit" disabled={busy}>
                {busy ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </form>
        </div>
      )}

      {passwordFor && (
        <div className="panel">
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Cambiar contraseña de {passwordFor.name}</h3>
          <form onSubmit={changePassword}>
            <div style={{ maxWidth: 320 }}>
              <label htmlFor="edit-password">Nueva contraseña (mínimo 8)</label>
              <input
                id="edit-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </div>

            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setPasswordFor(null);
                  setNewPassword('');
                }}
              >
                Cancelar
              </button>
              <button type="submit" disabled={busy}>
                {busy ? 'Cambiando…' : 'Cambiar clave'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="panel">
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Nuevo usuario</h3>
        <form onSubmit={createUser}>
          <div className="grid3">
            <div>
              <label htmlFor="new-name">Nombre</label>
              <input
                id="new-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="new-username">Usuario</label>
              <input
                id="new-username"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                pattern="[A-Za-z0-9._\-]{3,32}"
                title="3 a 32 caracteres: letras, números, punto, guion o guion bajo"
                autoCapitalize="none"
                spellCheck="false"
                required
              />
            </div>
            <div>
              <label htmlFor="new-password">Contraseña (mínimo 8)</label>
              <input
                id="new-password"
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                minLength={8}
                required
              />
            </div>
          </div>

          <div style={{ marginTop: 12, maxWidth: 280 }}>
            <label htmlFor="new-role">Rol inicial</label>
            <select
              id="new-role"
              value={form.roles[0]}
              onChange={(event) => setForm({ ...form, roles: [event.target.value] })}
            >
              {roles.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name}
                </option>
              ))}
            </select>
          </div>

          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? 'Creando…' : 'Crear usuario'}
            </button>
          </div>
        </form>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Sección</th>
              {roles.map((role) => (
                <th key={role.key}>{role.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <tr key={section}>
                <td>{section}</td>
                {roles.map((role) => {
                  const granted = permissions.filter(
                    (permission) => permission.section === section && role.permissions.includes(permission.key),
                  );
                  return (
                    <td key={role.key}>
                      {granted.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="pill-list">
                          {granted.map((permission) => (
                            <span key={permission.key} className="badge muted" title={permission.action}>
                              {permission.action}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
