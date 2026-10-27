import { useEffect, useMemo, useRef, useState } from 'react';
import { api, download, money } from '../api.js';

const PAGE_SIZES = [10, 30, 50, 100];

const emptyForm = {
  name: '',
  barcode: '',
  lfCode: '',
  price: '',
  unitCode: 4,
  department: 21,
  validityDays: 365,
  packageType: 0,
  pluNumber: 0,
  barcodeType: 7,
};

export default function Articles({ user }) {
  const canRead = user.permissions.includes('articles.read');
  const canWrite = user.permissions.includes('articles.write');

  const [articles, setArticles] = useState([]);
  const [meta, setMeta] = useState({ units: [], packageTypes: [] });
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(null);
  const [notice, setNotice] = useState(null);
  const [menu, setMenu] = useState(null);
  const [searching, setSearching] = useState(false);
  const firstRun = useRef(true);

  async function load() {
    const [catalogData, metaData] = await Promise.all([api('/articles'), api('/units')]);
    setArticles(catalogData.articles);
    setMeta(metaData);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  // Progressive search: the term settles while typing, so the table never jumps.
  // The spinner covers the settle window instead of flashing an instant no-op.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      setTerm(query.trim().toLowerCase());
      setPage(1);
      setSearching(false);
    }, 280);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const unitLabel = (code) => meta.units.find((unit) => unit.code === code)?.label ?? `código ${code}`;

  const filtered = useMemo(() => {
    if (!term) return articles;
    return articles.filter(
      (article) =>
        article.name.toLowerCase().includes(term) ||
        String(article.barcode).includes(term) ||
        String(article.lfCode) === term,
    );
  }, [articles, term]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  const from = filtered.length === 0 ? 0 : start + 1;
  const to = Math.min(start + pageSize, filtered.length);

  async function exportCatalog(format) {
    setError(null);
    setNotice(null);
    setExporting(format);
    const today = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
    const label = format === 'xlsx' ? 'Excel' : '.Txp';
    try {
      await download(`/articles/export?format=${format}`, `maestro-balanza-${stamp}.${format}`);
    } catch (err) {
      setError(`No se pudo exportar el maestro en ${label}: ${err.message}`);
    } finally {
      setExporting(null);
    }
  }

  async function startCreate() {
    setError(null);
    setErrors([]);
    setNotice(null);
    try {
      const suggestion = await api('/articles/suggest');
      setForm({
        ...emptyForm,
        barcode: String(suggestion.barcode),
        lfCode: String(suggestion.lfCode),
        unitCode: meta.units[0]?.code ?? 4,
      });
      setEditing('new');
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit(article) {
    setMenu(null);
    setError(null);
    setErrors([]);
    setNotice(null);
    setForm({
      name: article.name,
      barcode: String(article.barcode),
      lfCode: String(article.lfCode),
      price: money(article.priceCents),
      unitCode: article.unitCode,
      department: article.department,
      validityDays: article.validityDays,
      packageType: article.packageType,
      pluNumber: article.pluNumber,
      barcodeType: article.barcodeType,
    });
    setEditing(article);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setErrors([]);
    const payload = {
      name: form.name,
      barcode: Number(form.barcode),
      lfCode: Number(form.lfCode),
      priceCents: Math.round(Number(form.price) * 100),
      unitCode: Number(form.unitCode),
      department: Number(form.department),
      validityDays: Number(form.validityDays),
      packageType: Number(form.packageType),
      pluNumber: Number(form.pluNumber) || 0,
      barcodeType: Number(form.barcodeType) || 7,
    };
    try {
      if (editing === 'new') await api('/articles', { method: 'POST', body: payload });
      else await api(`/articles/${editing.id}`, { method: 'PATCH', body: payload });
      setEditing(null);
      setNotice(
        editing === 'new'
          ? 'Artículo creado. Queda pendiente de publicar a las sedes.'
          : 'Artículo actualizado. Queda pendiente de publicar.',
      );
      await load();
    } catch (err) {
      setError(err.message);
      setErrors(err.details?.validation?.errors ?? []);
    } finally {
      setBusy(false);
    }
  }

  async function remove(article) {
    setMenu(null);
    if (!window.confirm(`¿Eliminar "${article.name}" (código ${article.barcode})?`)) return;
    try {
      await api(`/articles/${article.id}`, { method: 'DELETE' });
      setNotice('Artículo eliminado. Queda pendiente de publicar.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function openMenu(event, article) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ article, x: Math.max(8, rect.right - 168), y: rect.bottom + 6 });
  }

  return (
    <section>
      <h2>Maestro de artículos</h2>
      <div className="sub">
        {articles.length} artículos · los cambios no llegan a la balanza hasta publicarlos
      </div>

      {notice && <div className="alert info">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <div className="row">
          <div style={{ flex: '1 1 320px' }}>
            <label htmlFor="q">Buscar por nombre, código o LF</label>
            <div className="search-field">
              <input
                id="q"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Escribí para filtrar…"
                autoComplete="off"
                aria-busy={searching}
              />
              {searching && <span className="spinner-sm" aria-hidden="true" />}
            </div>
            {searching && <span className="search-hint">Buscando…</span>}
          </div>
          {(canRead || canWrite) && (
            <div className="tight" style={{ display: 'flex', gap: 8 }}>
              {canRead && (
                <>
                  <button onClick={() => exportCatalog('xlsx')} disabled={exporting !== null}>
                    {exporting === 'xlsx' ? 'Exportando Excel…' : 'Exportar Excel'}
                  </button>
                  <button onClick={() => exportCatalog('txp')} disabled={exporting !== null}>
                    {exporting === 'txp' ? 'Exportando .Txp…' : 'Exportar .Txp'}
                  </button>
                </>
              )}
              {canWrite && <button onClick={startCreate}>Nuevo artículo</button>}
            </div>
          )}
        </div>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th className="num">Código</th>
              <th>Nombre</th>
              <th className="num hide-sm">LF</th>
              <th className="num">Precio</th>
              <th>Unidad</th>
              <th className="num hide-sm">Depto</th>
              <th className="num hide-sm">Validez</th>
              <th className="hide-sm">Tipo</th>
              {canWrite && <th className="actions-col" />}
            </tr>
          </thead>
          <tbody className={searching ? 'is-loading' : ''}>
            {visible.map((article) => (
              <tr key={article.id}>
                <td className="num mono">{article.barcode}</td>
                <td>{article.name}</td>
                <td className="num hide-sm">{article.lfCode}</td>
                <td className="num">{money(article.priceCents)}</td>
                <td>{unitLabel(article.unitCode)}</td>
                <td className="num hide-sm">{article.department}</td>
                <td className="num hide-sm">{article.validityDays}</td>
                <td className="hide-sm">{article.packageType === 2 ? 'Por unidad' : 'Normal'}</td>
                {canWrite && (
                  <td className="actions-col">
                    <div className="desk-actions">
                      <button className="btn-sm" onClick={() => startEdit(article)}>
                        Editar
                      </button>
                      <button className="btn-sm danger" onClick={() => remove(article)}>
                        Eliminar
                      </button>
                    </div>
                    <div className="mob-actions">
                      <button className="btn-sm" onClick={(event) => openMenu(event, article)}>
                        Acción ▾
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={canWrite ? 9 : 8} className="muted">
                  {term ? `Sin resultados para "${query}".` : 'Todavía no hay artículos.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="pagination">
          <div className="pagination-info">
            {from}–{to} de {filtered.length}
          </div>

          <div className="pagination-controls">
            <label htmlFor="page-size" className="pagination-size">
              Ver
              <select
                id="page-size"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>

            <button className="page-btn" onClick={() => setPage(1)} disabled={currentPage === 1} aria-label="Primera página" title="Primera página">
              «
            </button>
            <button
              className="page-btn"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 1}
              aria-label="Página anterior"
              title="Anterior"
            >
              ‹
            </button>
            <span className="page-indicator" aria-live="polite">
              {currentPage} / {pageCount}
            </span>
            <button
              className="page-btn"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage === pageCount}
              aria-label="Página siguiente"
              title="Siguiente"
            >
              ›
            </button>
            <button
              className="page-btn"
              onClick={() => setPage(pageCount)}
              disabled={currentPage === pageCount}
              aria-label="Última página"
              title="Última página"
            >
              »
            </button>
          </div>
        </div>
      </div>

      {menu && (
        <div className="mini-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
          <button onClick={() => startEdit(menu.article)}>Editar</button>
          <button className="danger" onClick={() => remove(menu.article)}>
            Eliminar
          </button>
        </div>
      )}

      {editing && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}
        >
          <form className="modal" onSubmit={submit}>
            <h3>{editing === 'new' ? 'Nuevo artículo' : `Editar ${editing.name}`}</h3>

            {error && (
              <div className="alert error">
                {error}
                {errors.length > 0 && (
                  <ul>
                    {errors.map((issue, index) => (
                      <li key={index}>{issue.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <label>Nombre</label>
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              maxLength={72}
              required
            />

            <div className="grid3" style={{ marginTop: 12 }}>
              <div>
                <label>Código de barra</label>
                <input
                  value={form.barcode}
                  onChange={(event) => setForm({ ...form, barcode: event.target.value })}
                  inputMode="numeric"
                  required
                />
              </div>
              <div>
                <label>LF code</label>
                <input
                  value={form.lfCode}
                  onChange={(event) => setForm({ ...form, lfCode: event.target.value })}
                  inputMode="numeric"
                  required
                />
              </div>
              <div>
                <label>Teclado</label>
                <input
                  value={form.pluNumber}
                  onChange={(event) => setForm({ ...form, pluNumber: event.target.value })}
                  inputMode="numeric"
                />
              </div>
            </div>

            <div className="grid3" style={{ marginTop: 12 }}>
              <div>
                <label>Precio</label>
                <input
                  value={form.price}
                  onChange={(event) => setForm({ ...form, price: event.target.value })}
                  inputMode="decimal"
                  placeholder="14.50"
                  required
                />
              </div>
              <div>
                <label>Unidad de peso</label>
                <select
                  value={form.unitCode}
                  onChange={(event) => setForm({ ...form, unitCode: event.target.value })}
                >
                  {meta.units.map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unit.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Departamento</label>
                <input
                  value={form.department}
                  onChange={(event) => setForm({ ...form, department: event.target.value })}
                  inputMode="numeric"
                  required
                />
              </div>
            </div>

            <div className="grid3" style={{ marginTop: 12 }}>
              <div>
                <label>Días de validez</label>
                <input
                  value={form.validityDays}
                  onChange={(event) => setForm({ ...form, validityDays: event.target.value })}
                  inputMode="numeric"
                  required
                />
              </div>
              <div>
                <label>Tipo de empaque</label>
                <select
                  value={form.packageType}
                  onChange={(event) => setForm({ ...form, packageType: event.target.value })}
                >
                  {meta.packageTypes.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Tipo de código</label>
                <input
                  value={form.barcodeType}
                  onChange={(event) => setForm({ ...form, barcodeType: event.target.value })}
                  inputMode="numeric"
                />
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
    </section>
  );
}
