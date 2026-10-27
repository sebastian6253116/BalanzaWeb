import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Status() {
  const [sedes, setSedes] = useState([]);
  const [sedeId, setSedeId] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/sedes')
      .then((data) => {
        setSedes(data.sedes);
        if (data.sedes.length) setSedeId(String(data.sedes[0].id));
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!sedeId) return;
    api(`/sedes/${sedeId}/status`)
      .then(setStatus)
      .catch((err) => setError(err.message));
  }, [sedeId]);

  return (
    <section>
      <h2>Estado de sincronización</h2>
      <div className="sub">Última revisión publicada y resultado real reportado por el microservicio</div>

      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <label>Sede</label>
        <select value={sedeId} onChange={(event) => setSedeId(event.target.value)}>
          {sedes.map((sede) => (
            <option key={sede.id} value={sede.id}>
              {sede.name}
            </option>
          ))}
        </select>
      </div>

      {status && (
        <>
          <div className="panel">
            <div className="grid3">
              <div>
                <label>Revisión publicada</label>
                <div>{status.lastDeployment ? status.lastDeployment.revision : '—'}</div>
              </div>
              <div>
                <label>Artículos en la revisión</label>
                <div>{status.lastDeployment ? status.lastDeployment.article_count : '—'}</div>
              </div>
              <div>
                <label>Publicada</label>
                <div className="muted">
                  {status.lastDeployment ? new Date(status.lastDeployment.created_at).toLocaleString() : '—'}
                </div>
              </div>
            </div>
          </div>

          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Balanza</th>
                  <th>Dirección</th>
                  <th>Resultado</th>
                  <th>Última conexión</th>
                </tr>
              </thead>
              <tbody>
                {status.scales.map((scale) => (
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
              </tbody>
            </table>
          </div>

          <div className="panel">
            <label>Agentes de la sede</label>
            {status.agents.length === 0 && <p className="muted">Todavía no hay ningún microservicio autorizado.</p>}
            {status.agents.map((agent) => (
              <div key={agent.id} style={{ marginBottom: 6 }}>
                <span className="mono">{agent.machine_id ?? `agente ${agent.id}`}</span>{' '}
                {agent.revoked_at ? (
                  <span className="badge err">revocado</span>
                ) : (
                  <span className="badge ok">activo</span>
                )}{' '}
                <span className="muted">
                  último contacto: {agent.last_seen_at ? new Date(agent.last_seen_at).toLocaleString() : 'nunca'}
                </span>
              </div>
            ))}
          </div>

          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th className="num">Revisión</th>
                  <th>Resultado</th>
                  <th className="num">Registros</th>
                  <th className="num">Tramas</th>
                  <th className="num">Duración</th>
                  <th>Error</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {status.results.map((row) => (
                  <tr key={row.id}>
                    <td className="num">{row.revision}</td>
                    <td>{row.ok ? <span className="badge ok">ok</span> : <span className="badge err">falló</span>}</td>
                    <td className="num">{row.records ?? '—'}</td>
                    <td className="num">{row.frames ?? '—'}</td>
                    <td className="num">{row.duration_ms ? `${row.duration_ms} ms` : '—'}</td>
                    <td className="muted">{row.error ?? '—'}</td>
                    <td className="muted">{new Date(row.created_at).toLocaleString()}</td>
                  </tr>
                ))}
                {status.results.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Sin envíos registrados todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
