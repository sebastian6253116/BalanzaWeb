import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Sedes({ user }) {
  const canWrite = user.permissions.includes('sedes.write');
  const canScales = user.permissions.includes('scales.write');
  const canAgents = user.permissions.includes('agents.manage');

  const [sedes, setSedes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [scales, setScales] = useState([]);
  const [pairing, setPairing] = useState(null);
  const [error, setError] = useState(null);
  const [newSede, setNewSede] = useState('');
  const [newScale, setNewScale] = useState({ name: '', host: '', port: 5001 });

  async function loadSedes() {
    const data = await api('/sedes');
    setSedes(data.sedes);
    if (!selected && data.sedes.length) setSelected(data.sedes[0]);
  }

  async function loadScales(sedeId) {
    if (!sedeId) return;
    const data = await api(`/sedes/${sedeId}/scales`);
    setScales(data.scales);
  }

  useEffect(() => {
    loadSedes().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setPairing(null);
    loadScales(selected?.id).catch((err) => setError(err.message));
  }, [selected?.id]);

  async function createSede(event) {
    event.preventDefault();
    setError(null);
    try {
      await api('/sedes', { method: 'POST', body: { name: newSede } });
      setNewSede('');
      await loadSedes();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createScale(event) {
    event.preventDefault();
    setError(null);
    try {
      await api(`/sedes/${selected.id}/scales`, {
        method: 'POST',
        body: { name: newScale.name, host: newScale.host, port: Number(newScale.port) },
      });
      setNewScale({ name: '', host: '', port: 5001 });
      await loadScales(selected.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function generateCode() {
    setError(null);
    try {
      const data = await api(`/sedes/${selected.id}/pairing-code`, { method: 'POST' });
      setPairing(data);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section>
      <h2>Sedes y balanzas</h2>
      <div className="sub">Cada sede tiene su microservicio local y sus balanzas en la red interna</div>

      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <div className="row">
          <div>
            <label>Nueva sede</label>
            <input
              value={newSede}
              onChange={(event) => setNewSede(event.target.value)}
              placeholder="Sede Centro"
              disabled={!canWrite}
            />
          </div>
          <div className="tight">
            <button onClick={createSede} disabled={!canWrite || !newSede.trim()}>
              Crear sede
            </button>
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Sede</th>
              <th className="num">Revisión</th>
              <th className="num">Polling</th>
              <th>Cambios</th>
            </tr>
          </thead>
          <tbody>
            {sedes.map((sede) => (
              <tr
                key={sede.id}
                onClick={() => setSelected(sede)}
                style={{ cursor: 'pointer', background: selected?.id === sede.id ? '#eef6fc' : undefined }}
              >
                <td>{sede.name}</td>
                <td className="num">{sede.revision}</td>
                <td className="num">{sede.poll_interval_seconds}s</td>
                <td>
                  {sede.pendingChanges ? <span className="badge warn">sin publicar</span> : <span className="badge ok">al día</span>}
                </td>
              </tr>
            ))}
            {sedes.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Todavía no hay sedes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <>
          <h2 style={{ marginTop: 26, fontSize: 17 }}>Balanzas de {selected.name}</h2>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Dirección</th>
                  <th>Último resultado</th>
                  <th>Última conexión</th>
                </tr>
              </thead>
              <tbody>
                {scales.map((scale) => (
                  <tr key={scale.id}>
                    <td>{scale.name}</td>
                    <td className="mono">
                      {scale.host}:{scale.port}
                    </td>
                    <td>
                      {scale.last_result === 'ok' ? (
                        <span className="badge ok">ok</span>
                      ) : scale.last_result ? (
                        <span className="badge err">{scale.last_result}</span>
                      ) : (
                        <span className="badge muted">sin datos</span>
                      )}
                    </td>
                    <td className="muted">{scale.last_seen_at ? new Date(scale.last_seen_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
                {scales.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      Esta sede no tiene balanzas cargadas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="row">
              <div>
                <label>Nombre</label>
                <input
                  value={newScale.name}
                  onChange={(event) => setNewScale({ ...newScale, name: event.target.value })}
                  placeholder="Caja 1"
                  disabled={!canScales}
                />
              </div>
              <div>
                <label>IP</label>
                <input
                  value={newScale.host}
                  onChange={(event) => setNewScale({ ...newScale, host: event.target.value })}
                  placeholder="192.168.0.201"
                  disabled={!canScales}
                />
              </div>
              <div>
                <label>Puerto</label>
                <input
                  value={newScale.port}
                  onChange={(event) => setNewScale({ ...newScale, port: event.target.value })}
                  inputMode="numeric"
                  disabled={!canScales}
                />
              </div>
              <div className="tight">
                <button onClick={createScale} disabled={!canScales || !newScale.name || !newScale.host}>
                  Agregar balanza
                </button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="row" style={{ alignItems: 'center' }}>
              <div>
                <label>Código de autorización del microservicio</label>
                <div className="muted">Se usa una sola vez, al instalar el agente en la sede. Vence en 15 minutos.</div>
              </div>
              <div className="tight">
                <button className="ghost" onClick={generateCode} disabled={!canAgents}>
                  Generar código
                </button>
              </div>
            </div>
            {pairing && (
              <div className="alert info" style={{ marginTop: 12 }}>
                Código: <span className="scale-code">{pairing.code}</span>
                <br />
                Vence: {new Date(pairing.expiresAt).toLocaleString()}
                <br />
                En la PC de la sede: <span className="mono">balanza-agent enroll --api &lt;url&gt; --code {pairing.code}</span>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
