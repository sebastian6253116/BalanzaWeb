import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Publish() {
  const [sedes, setSedes] = useState([]);
  const [sedeId, setSedeId] = useState('');
  const [scales, setScales] = useState([]);
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/sedes')
      .then((data) => {
        setSedes(data.sedes);
        if (data.sedes.length) setSedeId(String(data.sedes[0].id));
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setResult(null);
    setSelected([]);
    if (!sedeId) return;
    api(`/sedes/${sedeId}/scales`)
      .then((data) => setScales(data.scales))
      .catch((err) => setError(err.message));
  }, [sedeId]);

  async function publish() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = all ? {} : { scaleIds: selected };
      if (!all && selected.length === 0) throw new Error('Elegí al menos una balanza');
      const data = await api(`/sedes/${sedeId}/deployments`, { method: 'POST', body });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const sede = sedes.find((candidate) => String(candidate.id) === String(sedeId));

  return (
    <section>
      <h2>Publicar cambios</h2>
      <div className="sub">
        Genera una revisión nueva. El microservicio de la sede la baja en su próximo ciclo y envía a las balanzas que
        correspondan.
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <div className="row">
          <div>
            <label>Sede</label>
            <select value={sedeId} onChange={(event) => setSedeId(event.target.value)}>
              {sedes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.pendingChanges ? ' — con cambios sin publicar' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="tight">
            <button onClick={publish} disabled={busy || !sedeId}>
              {busy ? 'Publicando…' : 'Publicar'}
            </button>
          </div>
        </div>

        {sede?.pendingChanges === false && (
          <div className="alert info" style={{ marginTop: 12 }}>
            Esta sede ya está al día con el maestro. Publicar de todos modos fuerza un envío nuevo.
          </div>
        )}
      </div>

      <div className="panel">
        <label>Destino</label>
        <div className="row" style={{ alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'inherit', fontSize: 14, flex: '0 0 auto' }}>
            <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} style={{ width: 'auto' }} />
            Todas las balanzas
          </label>
        </div>

        {!all && (
          <div style={{ marginTop: 12 }}>
            {scales.map((scale) => (
              <label
                key={scale.id}
                style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'inherit', fontSize: 14, marginBottom: 6 }}
              >
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={selected.includes(scale.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, scale.id] : current.filter((id) => id !== scale.id),
                    )
                  }
                />
                {scale.name} <span className="muted mono">({scale.host}:{scale.port})</span>
              </label>
            ))}
            {scales.length === 0 && <p className="muted">La sede no tiene balanzas cargadas.</p>}
          </div>
        )}
      </div>

      {result && (
        <div className="alert info">
          Revisión <strong>{result.revision}</strong> publicada con {result.articleCount} artículos.
          <br />
          El microservicio la tomará en su próximo ciclo de consulta.
        </div>
      )}
    </section>
  );
}
