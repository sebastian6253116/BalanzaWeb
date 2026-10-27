/**
 * First-run bootstrap.
 *
 * The application refuses to start with zero users, so the first account is
 * created from the environment. Every later account is managed from the web.
 */
import { hashPassword } from './auth.js';
import { now } from './db.js';

export function userCount(db) {
  return db.get('SELECT COUNT(*) AS n FROM users').n;
}

export function ensureFirstUser(db, { username, password, name = 'Administrador', role = 'admin' }) {
  if (userCount(db) > 0) return null;
  if (!username || !password) {
    throw new Error('no users exist: set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD to create the first account');
  }
  const roleRow = db.get('SELECT * FROM roles WHERE key = ?', role);
  if (!roleRow) throw new Error(`role "${role}" is missing; the schema seed did not run`);

  const login = String(username).trim().toLowerCase();
  db.run(
    'INSERT INTO users (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
    login,
    name,
    hashPassword(password),
    now(),
  );
  const user = db.get('SELECT * FROM users WHERE username = ?', login);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', user.id, roleRow.id);
  return { id: user.id, username: user.username, name: user.name, role: roleRow.key };
}
