import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const CHECK_LABEL = { display: 'flex', gap: 8, alignItems: 'center', color: 'inherit', fontSize: 14, margin: 0 };

export default function Publish() {
  const [sedes, setSedes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState([]);
  // Only explicit operator choices live here; a missing entry means "sync" (checked by default).
  const [syncBySede, setSyncBySede] = useState({});
  const [scales, setScales] = useState([]);
  const [allScales, setAllScales] = useState(true);
  const [scaleSel, setScaleSel] = useState([]);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // State updates are async, so `busy` alone cannot stop two clicks in the same
  // tick from starting two batches. The ref is the real synchronous lock.
  const busyRef = useRef(false);
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    let active = true;
    api('/sedes')
      .then((data) => {
        if (!active) return;
        setSedes(data.sedes);
      })
      .catch((err) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const singleId = selectedIds.length === 1 ? selectedIds[0] : null;

  useEffect(() => {
    setAllScales(true);
    setScaleSel([]);
    if (!singleId) {
      setScales([]);
      return undefined;
    }
    let active = true;
    api(`/sedes/${singleId}/scales`)
      .then((data) => {
        if (active) setScales(data.scales);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [singleId]);

  const selectedSedes = sedes.filter((sede) => selectedIds.includes(String(sede.id)));
  const noSelection = selectedSedes.length === 0;
  const missingScales = selectedSedes.length === 1 && !allScales && scaleSel.length === 0;
  const upToDateSelected = selectedSedes.filter((sede) => !sede.pendingChanges);

  function toggleSede(id) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
    );
  }

  function toggleScale(id) {
    setScaleSel((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
    );
  }

  async function publish() {
    // Take the lock before the first await: a second click during the `/sedes`
    // refresh or the confirm dialog must not start a duplicate batch and compute
    // the same revision twice. `busy` as state lands too late, so the ref is the
    // synchronous guard.
    if (busy || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (noSelection || missingScales) return;

      // Reload before confirming: the count the operator sees, and later echoes back
      // as `expectedOverrides`, must be the count the API is about to destroy.
      let freshSedes;
      try {
        const data = await api('/sedes');
        freshSedes = data.sedes;
      } catch (err) {
        setError(`No se pudo refrescar la lista de sedes: ${err.message}`);
        return;
      }
      setSedes(freshSedes);
      const keptIds = selectedIds.filter(
        (id) => freshSedes.some((sede) => String(sede.id) === id),
      );
      setSelectedIds(keptIds);
      if (keptIds.length === 0) {
        setError('Las sedes seleccionadas ya no existen; elegí nuevamente.');
        return;
      }
      const targets = freshSedes.filter((sede) => keptIds.includes(String(sede.id)));

      const syncingSedes = targets.filter(
        (sede) => Boolean(sede.generalAhead) && syncBySede[String(sede.id)] !== false,
      );

      // A sync replaces the whole sede master: spell out what is destroyed before
      // the loop starts, not one confirm per sede halfway through the batch.
      if (syncingSedes.length > 0) {
        const totalOverrides = syncingSedes.reduce(
          (total, sede) => total + (Number(sede.overrides) || 0),
          0,
        );
        const names = syncingSedes.map((sede) => sede.name).join(', ');
        const lines = [
          `Se van a sincronizar ${syncingSedes.length} sede${syncingSedes.length === 1 ? '' : 's'} antes de publicar: ${names}.`,
          '',
        ];
        if (totalOverrides > 0) {
          lines.push(
            `Esas sedes tienen ${totalOverrides} artículo${totalOverrides === 1 ? '' : 's'} con valores distintos al maestro general. Se reemplazan por los del general y no se puede deshacer.`,
          );
        } else {
          lines.push(
            'Esas sedes no tienen artículos con valores distintos al maestro general: la sincronización solo aplica los cambios del general y no se pierde ningún valor por sede.',
          );
        }
        lines.push('', '¿Continuar?');
        // Cancelling here must leave the page usable: the finally below releases
        // the lock and no deployment request has been sent.
        if (!window.confirm(lines.join('\n'))) return;
      }

      const targetScaleIds = targets.length === 1 && !allScales ? [...scaleSel] : null;
      const collected = [];

      setError(null);
      setResults(null);
      setProgress({ current: 1, total: targets.length });

      for (let index = 0; index < targets.length; index += 1) {
        const sede = targets[index];
        const key = String(sede.id);
        const wantsSync = Boolean(sede.generalAhead) && syncBySede[key] !== false;
        const entry = { sedeId: sede.id, sede: sede.name, ok: false, synced: wantsSync };

        setProgress({ current: index + 1, total: targets.length });

        try {
          const body = {};
          // An empty scale selection means "all scales", so it must not travel as
          // `scaleIds: []`: the API would store it and the deployment would reach
          // no scale while the UI reported success.
          if (targetScaleIds && targetScaleIds.length > 0) body.scaleIds = targetScaleIds;
          // Sync and deploy travel together: one transaction and one permission,
          // so a publisher does not need `articles.write` and a failed deploy
          // never leaves the master already overwritten. A sync already pulled
          // the general values, so `acceptGeneralChanges` is not needed (and is
          // only sent on the publish-without-sync path).
          if (wantsSync) {
            body.syncFromGeneral = true;
            // Content-bound consent: echo the override count shown above. If the
            // master changed in the meantime the API answers 409 instead of
            // destroying more rows than the operator approved.
            body.expectedOverrides = Number(sede.overrides) || 0;
          }
          // The operator saw the general-master warning and chose the sede master as-is.
          else if (sede.generalAhead) body.acceptGeneralChanges = true;

          const deployment = await api(`/sedes/${sede.id}/deployments`, { method: 'POST', body });
          entry.ok = true;
          entry.revision = deployment.revision;
          entry.articleCount = deployment.articleCount;
          entry.syncCounts = deployment.sync;
        } catch (err) {
          entry.error = err.message;
        }

        collected.push(entry);
      }

      setResults(collected);

      try {
        const data = await api('/sedes');
        setSedes(data.sedes);
        setSelectedIds((current) =>
          current.filter((id) => data.sedes.some((sede) => String(sede.id) === id)),
        );
      } catch (err) {
        setError(`No se pudo refrescar la lista de sedes: ${err.message}`);
      }
    } finally {
      // Releases the lock on every exit: cancel, refresh failure, or a batch end.
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
  }

  const allOk = results !== null && results.length > 0 && results.every((entry) => entry.ok);
  const failures = results ? results.filter((entry) => !entry.ok) : [];

  return (
    <section>
      <h2>Publicar cambios</h2>
      <div className="sub">
        Genera una revisión nueva por sede. El microservicio de cada sede la baja en su próximo ciclo y envía a las
        balanzas que correspondan.
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <label>Sedes</label>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
          Publicar una sede usa el maestro propio de esa sede. Si marcás «Sincronizar antes de publicar», primero se
          reemplaza por el maestro general.
        </div>

        {loading && <p className="muted">Cargando sedes…</p>}

        {!loading && sedes.length === 0 && <p className="muted">Todavía no hay sedes.</p>}

        {sedes.length > 0 && (
          <>
            <label style={{ ...CHECK_LABEL, marginBottom: 10 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={selectedIds.length === sedes.length}
                ref={(element) => {
                  if (element) {
                    element.indeterminate = selectedIds.length > 0 && selectedIds.length < sedes.length;
                  }
                }}
                disabled={busy}
                onChange={(event) =>
                  setSelectedIds(event.target.checked ? sedes.map((sede) => String(sede.id)) : [])
                }
              />
              Todas las sedes
            </label>

            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>Sede</th>
                  <th className="num">Revisión</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {sedes.map((sede) => {
                  const key = String(sede.id);
                  const checked = selectedIds.includes(key);
                  const syncChecked = syncBySede[key] !== false;
                  return (
                    <tr key={sede.id}>
                      <td>
                        <input
                          type="checkbox"
                          style={{ width: 'auto' }}
                          checked={checked}
                          disabled={busy}
                          onChange={() => toggleSede(key)}
                          aria-label={`Seleccionar ${sede.name}`}
                        />
                      </td>
                      <td>
                        {sede.name}
                        {sede.generalAhead && (
                          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                            El maestro general cambió en {sede.articlesAhead} artículo
                            {sede.articlesAhead === 1 ? '' : 's'}.
                            <label style={{ ...CHECK_LABEL, fontSize: 12.5, marginTop: 4 }}>
                              <input
                                type="checkbox"
                                style={{ width: 'auto' }}
                                checked={syncChecked}
                                disabled={busy || !checked}
                                onChange={(event) =>
                                  setSyncBySede((current) => ({ ...current, [key]: event.target.checked }))
                                }
                              />
                              Sincronizar antes de publicar
                            </label>
                          </div>
                        )}
                      </td>
                      <td className="num">{sede.revision}</td>
                      <td>
                        {sede.pendingChanges ? (
                          <span className="badge warn">sin publicar</span>
                        ) : (
                          <span className="badge ok">al día</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {upToDateSelected.length > 0 && (
          <div className="alert info" style={{ marginTop: 12, marginBottom: 0 }}>
            {upToDateSelected.length === 1 ? (
              <>
                {upToDateSelected[0].name} ya está al día con el maestro. Publicar de todos modos fuerza una revisión
                nueva.
              </>
            ) : (
              <>
                Estas sedes ya están al día con el maestro; publicar de todos modos fuerza una revisión nueva:
                <ul>
                  {upToDateSelected.map((sede) => (
                    <li key={sede.id}>{sede.name}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <label>Destino</label>

        {noSelection && <p className="muted">Elegí al menos una sede para publicar.</p>}

        {selectedSedes.length === 1 && (
          <>
            <div className="row" style={{ alignItems: 'center' }}>
              <label style={{ ...CHECK_LABEL, flex: '0 0 auto' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={allScales}
                  disabled={busy}
                  onChange={(event) => {
                    setAllScales(event.target.checked);
                    if (!event.target.checked) setScaleSel([]);
                  }}
                />
                Todas las balanzas
              </label>
            </div>

            {!allScales && (
              <div style={{ marginTop: 12 }}>
                {scales.map((scale) => (
                  <label
                    key={scale.id}
                    style={{ ...CHECK_LABEL, marginBottom: 6 }}
                  >
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={scaleSel.includes(scale.id)}
                      disabled={busy}
                      onChange={() => toggleScale(scale.id)}
                    />
                    {scale.name} <span className="muted mono">({scale.host}:{scale.port})</span>
                  </label>
                ))}
                {scales.length === 0 && <p className="muted">La sede no tiene balanzas cargadas.</p>}
              </div>
            )}
          </>
        )}

        {selectedSedes.length >= 2 && (
          <p className="muted" style={{ margin: 0 }}>
            Con varias sedes seleccionadas se publica a todas las balanzas de cada una.
          </p>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={publish} disabled={busy || noSelection || missingScales}>
            {busy && progress ? `Publicando ${progress.current} de ${progress.total}…` : 'Publicar'}
          </button>
          {noSelection && <span className="muted">No hay ninguna sede seleccionada.</span>}
          {missingScales && <span className="muted">Elegí al menos una balanza.</span>}
        </div>
      </div>

      {allOk && (
        <div className="alert info">
          {results.length === 1
            ? 'Publicación completada. El microservicio la tomará en su próximo ciclo de consulta.'
            : `Publicación completada en las ${results.length} sedes. Cada microservicio la tomará en su próximo ciclo de consulta.`}
        </div>
      )}

      {failures.length > 0 && (
        <div className="alert error">
          No se pudo publicar en {failures.length} sede{failures.length === 1 ? '' : 's'}:
          <ul>
            {failures.map((entry) => (
              <li key={entry.sedeId}>
                <strong>{entry.sede}</strong>: {entry.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Sede</th>
                <th>Resultado</th>
                <th>Sincronización</th>
              </tr>
            </thead>
            <tbody>
              {results.map((entry) => (
                <tr key={entry.sedeId}>
                  <td>{entry.sede}</td>
                  <td>
                    {entry.ok ? (
                      <>
                        Revisión <strong>{entry.revision}</strong> publicada con {entry.articleCount} artículo
                        {entry.articleCount === 1 ? '' : 's'}.
                      </>
                    ) : (
                      <span style={{ color: 'var(--danger)' }}>{entry.error}</span>
                    )}
                  </td>
                  <td className="muted">
                    {entry.syncCounts
                      ? (
                        <>
                          {entry.syncCounts.priceChanges} precio
                          {entry.syncCounts.priceChanges === 1 ? '' : 's'} actualizado
                          {entry.syncCounts.priceChanges === 1 ? '' : 's'} ·{' '}
                          {entry.syncCounts.overrides} artículo
                          {entry.syncCounts.overrides === 1 ? '' : 's'} con valores distintos
                          {' '}reemplazado
                          {entry.syncCounts.overrides === 1 ? '' : 's'}
                        </>
                      )
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
