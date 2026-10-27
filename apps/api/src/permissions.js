/**
 * Permission catalogue and seed roles.
 *
 * Permissions are section-scoped: every screen of the web application maps to one
 * key, so a role is simply a set of sections it can touch. The catalogue lives in
 * code (single source of truth) and is mirrored into `role_permissions` so the UI
 * can edit role presets without a deploy.
 */
export const PERMISSIONS = [
  { key: 'articles.read', section: 'Artículos', action: 'Ver el maestro' },
  { key: 'articles.write', section: 'Artículos', action: 'Crear y editar artículos' },
  { key: 'sedes.read', section: 'Sedes', action: 'Ver sedes' },
  { key: 'sedes.write', section: 'Sedes', action: 'Crear y editar sedes' },
  { key: 'scales.read', section: 'Balanzas', action: 'Ver balanzas' },
  { key: 'scales.write', section: 'Balanzas', action: 'Crear y editar balanzas' },
  { key: 'deployments.create', section: 'Publicaciones', action: 'Publicar cambios hacia una sede' },
  { key: 'status.read', section: 'Estado', action: 'Ver estado y resultados de sincronización' },
  { key: 'agents.manage', section: 'Agentes', action: 'Generar códigos y revocar agentes' },
  { key: 'users.manage', section: 'Usuarios', action: 'Administrar usuarios, roles y permisos' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export const ROLE_SEEDS = [
  {
    key: 'admin',
    name: 'Administrador',
    permissions: PERMISSION_KEYS,
  },
  {
    key: 'operator',
    name: 'Operador',
    permissions: [
      'articles.read', 'articles.write',
      'sedes.read', 'scales.read',
      'deployments.create', 'status.read',
    ],
  },
  {
    key: 'viewer',
    name: 'Consulta',
    permissions: ['articles.read', 'sedes.read', 'scales.read', 'status.read'],
  },
];

/**
 * Idempotent: creates the seed roles and their permissions.
 * Existing roles are left untouched unless they have no permissions at all, so an
 * administrator's customisations survive a restart.
 */
export function seedRoles(db) {
  for (const role of ROLE_SEEDS) {
    const existing = db.get('SELECT * FROM roles WHERE key = ?', role.key);
    let roleId;
    if (existing) {
      roleId = existing.id;
      const count = db.get('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = ?', roleId).n;
      if (count > 0) continue;
    } else {
      db.run('INSERT INTO roles (key, name) VALUES (?, ?)', role.key, role.name);
      roleId = db.get('SELECT * FROM roles WHERE key = ?', role.key).id;
    }
    for (const permission of role.permissions) {
      db.run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', roleId, permission);
    }
  }
}
