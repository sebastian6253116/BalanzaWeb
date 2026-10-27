import { useEffect, useState } from 'react';
import { api } from '../api.js';

const emptyUserForm = { name: '', username: '', password: '', roles: ['viewer'] };
const emptyRoleForm = { name: '', permissions: [] };

function deriveRoleKey(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function PermissionMatrix({ permissions, selected, onToggle, disabled = false }) {
  const sections = [...new Set(permissions.map((permission) => permission.section))];
  return (
    <div className="perm-matrix">
      {sections.map((section) => (
        <div key={section} className="perm-section">
          <div className="perm-section-title">{section}</div>
          <div className="perm-grid">
            {permissions
              .filter((permission) => permission.section === section)
              .map((permission) => {
                const checked = selected.includes(permission.key);
                return (
                  <label key={permission.key} className={`perm-chip${checked ? ' checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => onToggle(permission.key)}
                    />
                    <span className="perm-label">{permission.action}</span>
                    <span className="perm-key mono">{permission.key}</span>
                  </label>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Users({ user: currentUser }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [form, setForm] = useState(emptyUserForm);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('usuarios');
  const [query, setQuery] = useState('');
  const [showUserForm, setShowUserForm] = useState(false);
  const [showRoleForm, setShowRoleForm] = useState(false);
  const [openPermissions, setOpenPermissions] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', username: '', active: true });
  const [passwordFor, setPasswordFor] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [roleDrafts, setRoleDrafts] = useState({});
  const [permissionDrafts, setPermissionDrafts] = useState({});
  const [renamingRole, setRenamingRole] = useState(null);
  const [newRole, setNewRole] = useState(emptyRoleForm);

  async function load() {
    const [usersData, rolesData] = await Promise.all([api('/users'), api('/roles')]);
    setUsers(usersData.users);
    setRoles(rolesData.roles);
    setPermissions(rolesData.permissions);
    setRoleDrafts({});
    setPermissionDrafts({});
    setRenamingRole(null);
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
      setForm(emptyUserForm);
      setShowUserForm(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function cancelNewUser() {
    setForm(emptyUserForm);
    setShowUserForm(false);
  }

  function sameRoles(left, right) {
    return left.length === right.length && left.every((key) => right.includes(key));
  }

  function draftFor(user) {
    return roleDrafts[user.id] ?? user.roles;
  }

  function hasRoleDraft(user) {
    return Boolean(roleDrafts[user.id]) && !sameRoles(roleDrafts[user.id], user.roles);
  }

  function toggleRole(user, roleKey) {
    if (user.username === 'admin') return;
    const current = draftFor(user);
    const next = current.includes(roleKey)
      ? current.filter((key) => key !== roleKey)
      : [...current, roleKey];
    if (next.length === 0) {
      setError('El usuario debe tener al menos un rol.');
      return;
    }
    setError(null);
    setRoleDrafts((drafts) => {
      const updated = { ...drafts };
      if (sameRoles(next, user.roles)) delete updated[user.id];
      else updated[user.id] = next;
      return updated;
    });
  }

  async function saveRoles(user) {
    const draft = roleDrafts[user.id];
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/users/${user.id}/roles`, { method: 'PUT', body: { roles: draft } });
      setNotice(`Roles de "${user.username}" actualizados.`);
      setRoleDrafts({});
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function cancelRoles(user) {
    setRoleDrafts((drafts) => {
      const updated = { ...drafts };
      delete updated[user.id];
      return updated;
    });
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

  function samePermissions(left, right) {
    return left.length === right.length && left.every((key) => right.includes(key));
  }

  function permissionDraft(role) {
    return permissionDrafts[role.key] ?? role.permissions;
  }

  function hasPermissionDraft(role) {
    return Boolean(permissionDrafts[role.key]) && !samePermissions(permissionDrafts[role.key], role.permissions);
  }

  function togglePermission(role, permissionKey) {
    const current = permissionDraft(role);
    const next = current.includes(permissionKey)
      ? current.filter((key) => key !== permissionKey)
      : [...current, permissionKey];
    setPermissionDrafts((drafts) => {
      const updated = { ...drafts };
      if (samePermissions(next, role.permissions)) delete updated[role.key];
      else updated[role.key] = next;
      return updated;
    });
  }

  function discardPermissions(role) {
    setPermissionDrafts((drafts) => {
      const updated = { ...drafts };
      delete updated[role.key];
      return updated;
    });
  }

  function togglePermissionPanel(roleKey) {
    setOpenPermissions((current) => (current === roleKey ? null : roleKey));
  }

  async function savePermissions(role) {
    const draft = permissionDrafts[role.key];
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/roles/${role.key}/permissions`, { method: 'PUT', body: { permissions: draft } });
      setNotice(`Permisos del rol "${role.name}" actualizados.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function startRenameRole(role) {
    setRenamingRole({ key: role.key, name: role.name });
    setError(null);
    setNotice(null);
  }

  async function renameRole(role) {
    if (!renamingRole) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/roles/${role.key}`, { method: 'PATCH', body: { name: renamingRole.name } });
      setNotice(`Rol "${renamingRole.name}" renombrado.`);
      setRenamingRole(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeRole(role) {
    if (!window.confirm(`¿Eliminar el rol "${role.name}"? Esta acción no se puede deshacer.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/roles/${role.key}`, { method: 'DELETE' });
      setNotice(`Rol "${role.name}" eliminado.`);
      if (openPermissions === role.key) setOpenPermissions(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleNewRolePermission(permissionKey) {
    setNewRole((current) => ({
      ...current,
      permissions: current.permissions.includes(permissionKey)
        ? current.permissions.filter((key) => key !== permissionKey)
        : [...current.permissions, permissionKey],
    }));
  }

  function cancelNewRole() {
    setNewRole(emptyRoleForm);
    setShowRoleForm(false);
  }

  async function createRole(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/roles', { method: 'POST', body: { name: newRole.name, permissions: newRole.permissions } });
      setNotice(`Rol "${newRole.name}" creado.`);
      setNewRole(emptyRoleForm);
      setShowRoleForm(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canManageRoles = currentUser.permissions.includes('users.manage');
  const term = query.trim().toLowerCase();
  const filteredUsers = term
    ? users.filter(
        (user) => user.name.toLowerCase().includes(term) || user.username.toLowerCase().includes(term),
      )
    : users;
  const newRoleKey = deriveRoleKey(newRole.name);

  return (
    <section>
      <h2>Usuarios y permisos</h2>
      <div className="sub">Cada sección de la web depende de un permiso; un rol agrupa permisos</div>

      {notice && <div className="alert info">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="tabs" role="tablist" aria-label="Usuarios y roles">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'usuarios'}
          className={tab === 'usuarios' ? 'active' : ''}
          onClick={() => setTab('usuarios')}
        >
          Usuarios <span className="badge muted">{users.length}</span>
        </button>
        {canManageRoles && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'roles'}
            className={tab === 'roles' ? 'active' : ''}
            onClick={() => setTab('roles')}
          >
            Roles <span className="badge muted">{roles.length}</span>
          </button>
        )}
      </div>

      {tab === 'usuarios' && (
        <div id="tab-usuarios" role="tabpanel">
          <div className="toolbar">
            <div className="toolbar-search">
              <label htmlFor="user-search">Buscar por nombre o usuario</label>
              <input
                id="user-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Escribí para filtrar…"
                autoComplete="off"
              />
            </div>
            {!showUserForm && (
              <button type="button" onClick={() => setShowUserForm(true)}>
                Nuevo usuario
              </button>
            )}
          </div>

          {showUserForm && (
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
                      autoComplete="new-password"
                      required
                    />
                  </div>
                </div>

                <div className="grid2" style={{ marginTop: 12 }}>
                  <div>
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
                </div>

                <div className="actions">
                  <button type="button" className="ghost" disabled={busy} onClick={cancelNewUser}>
                    Cancelar
                  </button>
                  <button type="submit" disabled={busy}>
                    {busy ? 'Creando…' : 'Crear usuario'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="panel" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table-cards">
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
                  {filteredUsers.map((user) => (
                    <tr key={user.id}>
                      <td data-label="Nombre">{user.name}</td>
                      <td data-label="Usuario" className="mono">
                        {user.username}
                      </td>
                      <td data-label="Roles">
                        <div className="cell-body">
                          <div className="pill-list">
                            {roles.map((role) => {
                              const locked = user.username === 'admin';
                              const selected = draftFor(user).includes(role.key);
                              return (
                                <button
                                  key={role.key}
                                  type="button"
                                  className={selected ? '' : 'ghost'}
                                  style={{ padding: '5px 11px', fontSize: 12 }}
                                  disabled={locked || busy}
                                  onClick={() => toggleRole(user, role.key)}
                                  title={
                                    locked
                                      ? 'El rol del administrador no se puede cambiar'
                                      : `Alternar rol ${role.name}`
                                  }
                                >
                                  {role.name}
                                </button>
                              );
                            })}
                          </div>
                          {user.username === 'admin' && (
                            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              El rol del administrador no se puede cambiar
                            </div>
                          )}
                          {hasRoleDraft(user) && (
                            <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                              <button type="button" className="btn-sm" disabled={busy} onClick={() => saveRoles(user)}>
                                Guardar cambios
                              </button>
                              <button
                                type="button"
                                className="btn-sm ghost"
                                disabled={busy}
                                onClick={() => cancelRoles(user)}
                              >
                                Cancelar
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                      <td data-label="Estado">
                        {user.active ? (
                          <span className="badge ok">activo</span>
                        ) : (
                          <span className="badge muted">inactivo</span>
                        )}
                      </td>
                      <td data-label="Último ingreso" className="muted">
                        {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'nunca'}
                      </td>
                      <td data-label="Acciones" className="actions-col">
                        <div className="row-actions">
                          <button type="button" className="btn-sm" onClick={() => startEdit(user)}>
                            Editar
                          </button>
                          <button type="button" className="btn-sm ghost" onClick={() => startPassword(user)}>
                            Clave
                          </button>
                          {currentUser?.id !== user.id && (
                            <button
                              type="button"
                              className="btn-sm danger"
                              disabled={busy}
                              onClick={() => removeUser(user)}
                            >
                              Eliminar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredUsers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        {term ? `Sin resultados para "${query}".` : 'Todavía no hay usuarios.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
        </div>
      )}

      {canManageRoles && tab === 'roles' && (
        <div id="tab-roles" role="tabpanel">
          <div className="toolbar">
            <div className="toolbar-note muted">
              Un rol agrupa permisos. Los cambios se aplican en el siguiente request de cada usuario.
            </div>
            <button
              type="button"
              aria-expanded={showRoleForm}
              aria-controls="new-role-panel"
              onClick={() => setShowRoleForm((open) => !open)}
            >
              Nuevo rol
            </button>
          </div>

          {showRoleForm && (
            <div className="panel" id="new-role-panel">
              <h3 style={{ marginTop: 0, fontSize: 16 }}>Nuevo rol</h3>
              <form onSubmit={createRole}>
                <div className="grid2">
                  <div>
                    <label htmlFor="new-role-name">Nombre del rol</label>
                    <input
                      id="new-role-name"
                      value={newRole.name}
                      maxLength={60}
                      onChange={(event) => setNewRole({ ...newRole, name: event.target.value })}
                      required
                    />
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Clave que se creará: <span className="mono">{newRoleKey || '—'}</span>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div className="perm-section-title">Permisos</div>
                  <PermissionMatrix
                    permissions={permissions}
                    selected={newRole.permissions}
                    disabled={busy}
                    onToggle={toggleNewRolePermission}
                  />
                </div>

                <div className="actions">
                  <button type="button" className="ghost" disabled={busy} onClick={cancelNewRole}>
                    Cancelar
                  </button>
                  <button type="submit" disabled={busy || !newRole.name.trim()}>
                    {busy ? 'Creando…' : 'Crear rol'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {roles.map((role) => {
            const draft = permissionDraft(role);
            const assigned = users.filter((user) => user.roles.includes(role.key)).length;
            const changed = hasPermissionDraft(role);
            const open = openPermissions === role.key;
            return (
              <div key={role.key} className="role-card">
                <div className="role-card-head">
                  <div className="role-card-title">
                    <strong>{role.name}</strong>
                    <span className="mono muted">{role.key}</span>
                    <span className="badge muted">{draft.length} permisos</span>
                    {assigned > 0 && <span className="badge muted">asignado a {assigned} usuario(s)</span>}
                  </div>
                  <div className="role-card-actions">
                    <button
                      type="button"
                      className="btn-sm"
                      aria-expanded={open}
                      aria-controls={`role-perms-${role.key}`}
                      onClick={() => togglePermissionPanel(role.key)}
                    >
                      {open ? 'Ocultar permisos' : 'Ver permisos'}
                    </button>
                    <button
                      type="button"
                      className="btn-sm ghost"
                      disabled={busy}
                      onClick={() => startRenameRole(role)}
                    >
                      Renombrar
                    </button>
                    {role.key !== 'admin' && (
                      <button
                        type="button"
                        className="btn-sm danger"
                        disabled={busy || assigned > 0}
                        title={
                          assigned > 0
                            ? 'No se puede eliminar: el rol está asignado a usuarios'
                            : `Eliminar el rol ${role.name}`
                        }
                        onClick={() => removeRole(role)}
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                </div>

                {renamingRole?.key === role.key && (
                  <form
                    className="role-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      renameRole(role);
                    }}
                  >
                    <div className="role-rename-field">
                      <label htmlFor={`rename-role-${role.key}`}>Nombre del rol</label>
                      <input
                        id={`rename-role-${role.key}`}
                        value={renamingRole.name}
                        maxLength={60}
                        onChange={(event) => setRenamingRole({ ...renamingRole, name: event.target.value })}
                        required
                      />
                    </div>
                    <div className="role-rename-actions">
                      <button
                        type="submit"
                        className="btn-sm"
                        disabled={busy || !renamingRole.name.trim()}
                      >
                        Guardar
                      </button>
                      <button
                        type="button"
                        className="btn-sm ghost"
                        disabled={busy}
                        onClick={() => setRenamingRole(null)}
                      >
                        Cancelar
                      </button>
                    </div>
                  </form>
                )}

                {assigned > 0 && role.key !== 'admin' && (
                  <div className="role-hint muted">No se puede eliminar: el rol está asignado a usuarios.</div>
                )}

                {open && (
                  <div id={`role-perms-${role.key}`}>
                    <PermissionMatrix
                      permissions={permissions}
                      selected={draft}
                      disabled={busy}
                      onToggle={(permissionKey) => togglePermission(role, permissionKey)}
                    />
                    <div className="role-card-foot">
                      <button
                        type="button"
                        className="btn-sm ghost"
                        disabled={busy || !changed}
                        onClick={() => discardPermissions(role)}
                      >
                        Descartar
                      </button>
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busy || !changed}
                        onClick={() => savePermissions(role)}
                      >
                        Guardar permisos
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
