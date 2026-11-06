import { useEffect, useMemo, useRef, useState } from 'react';
import { api, download, money } from '../api.js';

const PAGE_SIZES = [10, 30, 50, 100];
const SCOPE_GENERAL = 'general';

/** Mirrors the server's sede slug so the fallback export name matches its content-disposition. */
const slugify = (value) =>
  String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

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
  const canReadSedes = user.permissions.includes('sedes.read');

  const [articles, setArticles] = useState([]);
  const [meta, setMeta] = useState({ units: [], packageTypes: [] });
  const [sedes, setSedes] = useState([]);
  const [scope, setScope] = useState(SCOPE_GENERAL);
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
  const [priceFlag, setPriceFlag] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const firstRun = useRef(true);
  // Latest scope the operator selected. Responses are applied only while this
  // still matches: an older master's rows must never be painted under the new
  // scope label, or editing one would PATCH the wrong master's values.
  const scopeRef = useRef(SCOPE_GENERAL);

  const isSede = scope !== SCOPE_GENERAL;
  const selectedSede = isSede ? sedes.find((sede) => sede.id === scope) ?? null : null;
  const interactionsBlocked = syncing || loading;

  async function loadSedes(keepScope = scope) {
    const data = await api('/sedes');
    const list = data.sedes ?? [];
    setSedes(list);
    // The sede could have been deleted from another tab while it was selected.
    if (keepScope !== SCOPE_GENERAL && !list.some((sede) => sede.id === keepScope)) {
      scopeRef.current = SCOPE_GENERAL;
      setScope(SCOPE_GENERAL);
    }
    return list;
  }

  async function loadArticles(scopeValue = scopeRef.current) {
    const data = await api(
      scopeValue === SCOPE_GENERAL ? '/articles' : `/articles?sedeId=${scopeValue}`,
    );
    // The scope may have moved while the request was in flight. Applying a
    // stale response here is exactly the race that paints one master's rows
    // under another master's label.
    if (scopeRef.current !== scopeValue) return;
    setArticles(data.articles ?? []);
  }

  useEffect(() => {
    api('/units').then(setMeta).catch((err) => setError(err.message));
    // Without sedes.read (or if the request fails) the page stays on the general scope.
    if (!canReadSedes) return;
    loadSedes().catch(() => setSedes([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Mirror the selected scope synchronously so any in-flight response from
    // the previous scope is discarded by its own comparison.
    scopeRef.current = scope;
    // Drop the previous scope's rows immediately: they belong to another master
    // and, if this fetch fails, they must never stay interactive under the new one.
    setLoading(true);
    setArticles([]);
    setMenu(null);
    setPriceFlag(null);
    api(scope === SCOPE_GENERAL ? '/articles' : `/articles?sedeId=${scope}`)
      .then((data) => {
        if (!cancelled && scopeRef.current === scope) setArticles(data.articles ?? []);
      })
      .catch((err) => {
        if (!cancelled && scopeRef.current === scope) {
          setArticles([]);
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled && scopeRef.current === scope) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

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

  // Same dismissal pattern as the row menu: only one price popover can be open.
  useEffect(() => {
    if (!priceFlag) return;
    const close = () => setPriceFlag(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [priceFlag]);

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
    const label = format === 'xlsx' ? 'Excel' : format === 'txp' ? '.Txp' : 'fabricante';
    const suffix = scope === SCOPE_GENERAL ? '' : `-${slugify(selectedSede?.name ?? '')}`;
    const filename = format === 'vendor'
      ? `maestro-balanza-${stamp}-fabricante${suffix}.xlsx`
      : `maestro-balanza-${stamp}${suffix}.${format}`;
    const scopeQuery = scope === SCOPE_GENERAL ? '' : `&sedeId=${scope}`;
    try {
      await download(`/articles/export?format=${format}${scopeQuery}`, filename);
    } catch (err) {
      setError(`No se pudo exportar el maestro en ${label}: ${err.message}`);
    } finally {
      setExporting(null);
    }
  }

  function changeScope(value) {
    const next = value === SCOPE_GENERAL ? SCOPE_GENERAL : Number(value);
    // Update the guard before React re-renders: a response that lands between
    // this click and the fetch effect belongs to the previous scope.
    scopeRef.current = next;
    setScope(next);
    // Clear synchronously so the previous master is never painted under the new
    // scope between this render and the fetch effect.
    setArticles([]);
    setLoading(true);
    setPage(1);
    setMenu(null);
    setPriceFlag(null);
    // Close the editor: its form belongs to the scope that was open when it started.
    setEditing(null);
    setError(null);
    setNotice(null);
    // Refresh the sede list so `articlesAhead` reflects the latest general master.
    if (next !== SCOPE_GENERAL && canReadSedes) loadSedes(next).catch(() => {});
  }

  async function syncSede() {
    if (!isSede || !selectedSede) return;
    // Reload before confirming: the count shown to the operator is the one the
    // API verifies, so a stale list can never understate what gets destroyed.
    let freshSedes;
    try {
      freshSedes = await loadSedes();
    } catch (err) {
      setError(`No se pudo refrescar la lista de sedes: ${err.message}`);
      return;
    }
    const current = freshSedes.find((sede) => sede.id === scope);
    if (!current) {
      setError('La sede seleccionada ya no existe.');
      return;
    }
    // `overrides` is how many articles differ from the general master, whether the
    // operator typed them here or the general moved after the last sync.
    const overrides = Number(current.overrides) || 0;
    const confirmation = [
      `¿Sincronizar el maestro de ${current.name} con el maestro general?`,
      '',
      'Se sobrescribe TODO el maestro de la sede con el del general.',
      overrides > 0
        ? `Se van a reemplazar ${overrides} artículo${overrides === 1 ? '' : 's'} con valores distintos al maestro general.`
        : 'Esta sede no tiene artículos con valores distintos al maestro general; la sincronización solo aplica los cambios del general.',
      '',
      'Los artículos nuevos del general se agregan y los que ya no existen se quitan.',
    ].join('\n');
    if (!window.confirm(confirmation)) return;

    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api(`/sedes/${scope}/articles/sync`, {
        method: 'POST',
        body: { expectedOverrides: overrides },
      });
      setNotice(
        `Maestro sincronizado: ${result.articles} artículos, ${result.priceChanges} precios actualizados.`,
      );
      await Promise.all([loadArticles(scopeRef.current), loadSedes()]);
    } catch (err) {
      // A 409 means the override count moved while the operator was confirming:
      // show the API's message and refresh the list so the next attempt is honest.
      setError(err.message);
      if (err.status === 409) loadSedes().catch(() => {});
    } finally {
      setSyncing(false);
    }
  }

  function openPriceFlag(event, article) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 240;
    setPriceFlag({
      id: article.id,
      x: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      y: rect.bottom + 8,
    });
  }

  async function startCreate() {
    if (interactionsBlocked) return;
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
    if (interactionsBlocked) return;
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
    if (interactionsBlocked) return;
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
      if (editing === 'new') {
        // Creating only exists in the general master; the API rejects sedeId here.
        await api('/articles', { method: 'POST', body: payload });
      } else {
        // In sede scope the edit lands on that sede's copy of the article.
        const path = scope === SCOPE_GENERAL
          ? `/articles/${editing.id}`
          : `/articles/${editing.id}?sedeId=${scope}`;
        await api(path, { method: 'PATCH', body: payload });
      }
      setEditing(null);
      setNotice(
        editing === 'new'
          ? 'Artículo creado. Queda pendiente de publicar a las sedes.'
          : scope === SCOPE_GENERAL
            ? 'Artículo actualizado. Queda pendiente de publicar.'
            : 'Artículo actualizado en esta sede. Queda pendiente de publicar.',
      );
      await loadArticles();
    } catch (err) {
      setError(err.message);
      setErrors(err.details?.validation?.errors ?? []);
    } finally {
      setBusy(false);
    }
  }

  async function remove(article) {
    setMenu(null);
    // Deleting is a general-master operation only; the action is hidden in sede scope.
    if (scope !== SCOPE_GENERAL || interactionsBlocked) return;
    const confirmation = [
      `¿Eliminar "${article.name}" (código ${article.barcode})?`,
      '',
      'También se quita de todas las sedes, incluidos los valores que cada sede tenga para este artículo.',
      'Esta acción no se puede deshacer.',
    ].join('\n');
    if (!window.confirm(confirmation)) return;
    try {
      await api(`/articles/${article.id}`, { method: 'DELETE' });
      setNotice('Artículo eliminado. Queda pendiente de publicar.');
      await loadArticles();
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
        {loading
          ? 'Cargando maestro…'
          : isSede
            ? `${articles.length} artículos en esta sede · los cambios no llegan a la balanza hasta publicarlos`
            : `${articles.length} artículos · los cambios no llegan a la balanza hasta publicarlos`}
      </div>

      {sedes.length > 0 && (
        <div className="panel">
          <div className="row">
            <div style={{ flex: '1 1 260px' }}>
              <label htmlFor="scope">Maestro</label>
              <select
                id="scope"
                value={scope}
                disabled={interactionsBlocked}
                onChange={(event) => changeScope(event.target.value)}
              >
                <option value={SCOPE_GENERAL}>Maestro general</option>
                {sedes.map((sede) => (
                  <option key={sede.id} value={sede.id}>
                    {sede.name}
                  </option>
                ))}
              </select>
            </div>
            {isSede && canWrite && (
              <div className="tight">
                <button type="button" className="ghost" onClick={syncSede} disabled={interactionsBlocked}>
                  {syncing ? 'Sincronizando…' : 'Sincronizar con el maestro general'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {isSede && selectedSede && (
        <div className="alert info">
          Maestro de {selectedSede.name}. Los precios y datos que edites acá solo se publican a las
          balanzas de esta sede.
          {selectedSede.articlesAhead > 0 && (
            <>
              <br />
              El maestro general cambió en {selectedSede.articlesAhead} artículos desde la última
              sincronización.
            </>
          )}
        </div>
      )}

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
                  <button onClick={() => exportCatalog('vendor')} disabled={exporting !== null}>
                    {exporting === 'vendor' ? 'Exportando fabricante…' : 'Exportar fabricante'}
                  </button>
                </>
              )}
              {canWrite && !isSede && <button onClick={startCreate} disabled={interactionsBlocked}>Nuevo artículo</button>}
            </div>
          )}
        </div>
        {canWrite && isSede && (
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Los artículos nuevos se crean en el maestro general y se copian a todas las sedes.
          </div>
        )}
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
          <tbody className={loading || searching ? 'is-loading' : ''}>
            {loading && (
              <tr>
                <td colSpan={canWrite ? 9 : 8} className="muted">
                  Cargando maestro…
                </td>
              </tr>
            )}
            {!loading && visible.map((article) => (
              <tr key={article.id}>
                <td className="num mono">{article.barcode}</td>
                <td>{article.name}</td>
                <td className="num hide-sm">{article.lfCode}</td>
                <td className="num">
                  <span className="price-cell">
                    {money(article.priceCents)}
                    {isSede && article.differsFromGeneral === true && (
                        <>
                          <button
                            type="button"
                            className="price-flag"
                            aria-label="Difiere del maestro general"
                            aria-describedby={
                              priceFlag?.id === article.id ? `price-flag-${article.id}` : undefined
                            }
                            onClick={(event) => {
                              if (priceFlag?.id === article.id) {
                                event.stopPropagation();
                                setPriceFlag(null);
                                return;
                              }
                              openPriceFlag(event, article);
                            }}
                            onPointerEnter={(event) => {
                              if (event.pointerType !== 'touch' && priceFlag?.id !== article.id) {
                                openPriceFlag(event, article);
                              }
                            }}
                            onPointerLeave={(event) => {
                              if (event.pointerType === 'touch') return;
                              const next = event.relatedTarget;
                              if (next instanceof Node && next.closest?.('.price-flag-pop')) return;
                              setPriceFlag((current) =>
                                current?.id === article.id ? null : current,
                              );
                            }}
                          >
                            <span aria-hidden="true">!</span>
                          </button>
                          {priceFlag?.id === article.id && (
                            <span
                              role="tooltip"
                              id={`price-flag-${article.id}`}
                              className="price-flag-pop"
                              style={{ left: priceFlag.x, top: priceFlag.y }}
                            >
                              {Number.isFinite(article.generalPriceCents) ? (
                                <>
                                  Precio en el maestro general:{' '}
                                  <strong>{money(article.generalPriceCents)}</strong>
                                  <br />
                                  Acá: <strong>{money(article.priceCents)}</strong>
                                  {article.generalPriceCents === article.priceCents && (
                                    <>
                                      <br />
                                      Otros datos difieren del maestro general.
                                    </>
                                  )}
                                </>
                              ) : (
                                <>Este artículo no está en el maestro general.</>
                              )}
                            </span>
                          )}
                        </>
                      )}
                  </span>
                </td>
                <td>{unitLabel(article.unitCode)}</td>
                <td className="num hide-sm">{article.department}</td>
                <td className="num hide-sm">{article.validityDays}</td>
                <td className="hide-sm">{article.packageType === 2 ? 'Por unidad' : 'Normal'}</td>
                {canWrite && (
                  <td className="actions-col">
                    <div className="desk-actions">
                      <button className="btn-sm" onClick={() => startEdit(article)} disabled={interactionsBlocked}>
                        Editar
                      </button>
                      {!isSede && (
                        <button className="btn-sm danger" onClick={() => remove(article)} disabled={interactionsBlocked}>
                          Eliminar
                        </button>
                      )}
                    </div>
                    <div className="mob-actions">
                      <button className="btn-sm" onClick={(event) => openMenu(event, article)} disabled={interactionsBlocked}>
                        Acción ▾
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={canWrite ? 9 : 8} className="muted">
                  {error
                    ? 'No se pudo cargar el maestro. Revisá el error de arriba.'
                    : term
                      ? `Sin resultados para "${query}".`
                      : isSede
                        ? 'Esta sede no tiene artículos cargados.'
                        : 'Todavía no hay artículos.'}
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
          <button onClick={() => startEdit(menu.article)} disabled={interactionsBlocked}>Editar</button>
          {!isSede && (
            <button className="danger" onClick={() => remove(menu.article)} disabled={interactionsBlocked}>
              Eliminar
            </button>
          )}
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
              <button type="submit" disabled={busy || syncing}>
                {busy ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
