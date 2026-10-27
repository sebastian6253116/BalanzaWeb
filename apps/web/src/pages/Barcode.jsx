import { useMemo, useRef, useState } from 'react';
import { buildRetailCode, code128Bars, ean13Bars } from '../lib/barcode.js';

const EAN13_QUIET_LEFT = 11;
const EAN13_QUIET_RIGHT = 7;
const CODE128_QUIET = 10;
const BAR_HEIGHT = 60;
const TEXT_HEIGHT = 20;
const MODULE_PIXELS = 2;

function formatEanText(code) {
  return `${code.slice(0, 1)} ${code.slice(1, 7)} ${code.slice(7)}`;
}

function BarcodeSvg({ svgRef, bars, modules, quietLeft, quietRight, humanText, label }) {
  const totalModules = quietLeft + modules + quietRight;
  const viewHeight = BAR_HEIGHT + TEXT_HEIGHT;

  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label={label}
      viewBox={`0 0 ${totalModules} ${viewHeight}`}
      width={totalModules * MODULE_PIXELS}
      height={viewHeight * MODULE_PIXELS}
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        maxWidth: totalModules * MODULE_PIXELS,
      }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width={totalModules} height={viewHeight} fill="#ffffff" />
      {bars.map((bar, index) => (
        <rect
          key={`${bar.x}-${index}`}
          x={quietLeft + bar.x}
          y="0"
          width={bar.width}
          height={BAR_HEIGHT}
          fill="#000000"
        />
      ))}
      <text
        x={quietLeft + modules / 2}
        y={BAR_HEIGHT + 14}
        textAnchor="middle"
        fontFamily="ui-monospace, 'Cascadia Mono', Consolas, monospace"
        fontSize="9"
        fill="#000000"
      >
        {humanText}
      </text>
    </svg>
  );
}

export default function Barcode() {
  const [reference, setReference] = useState('');
  const [result, setResult] = useState(null);
  const [symbology, setSymbology] = useState('ean13');
  const [error, setError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const svgRef = useRef(null);

  const encoded = useMemo(() => {
    if (!result) return null;

    const useEan13 = symbology === 'ean13' && result.numeric;
    const geometry = useEan13 ? ean13Bars(result.code) : code128Bars(result.reference);

    return {
      geometry,
      humanText: useEan13 ? formatEanText(result.code) : result.reference,
      quietLeft: useEan13 ? EAN13_QUIET_LEFT : CODE128_QUIET,
      quietRight: useEan13 ? EAN13_QUIET_RIGHT : CODE128_QUIET,
      label: useEan13
        ? `Código de barras EAN-13 ${result.code}`
        : `Código de barras CODE128 ${result.reference}`,
    };
  }, [result, symbology]);

  function submit(event) {
    event.preventDefault();
    const value = reference.trim();

    if (!value) {
      setError('Ingresá un número de artículo o referencia.');
      setResult(null);
      setDownloadError(null);
      return;
    }

    const retail = buildRetailCode(value);
    if (!retail.reference) {
      setError('La referencia no tiene caracteres válidos: usá letras y números.');
      setResult(null);
      setDownloadError(null);
      return;
    }

    setError(null);
    setDownloadError(null);
    setResult(retail);
    setSymbology(retail.numeric ? 'ean13' : 'code128');
  }

  async function downloadPng() {
    if (!encoded || !result) return;
    setDownloadError(null);

    const svg = svgRef.current;
    if (!svg) {
      setDownloadError('No se pudo preparar la imagen del código.');
      return;
    }

    try {
      const clone = svg.cloneNode(true);
      clone.removeAttribute('style');
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const source = new XMLSerializer().serializeToString(clone);
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('No se pudo convertir el código de barras en imagen.'));
        image.src = dataUrl;
      });

      const [, , boxWidth, boxHeight] = (svg.getAttribute('viewBox') ?? '0 0 0 0')
        .split(/\s+/)
        .map(Number);
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(boxWidth * scale);
      canvas.height = Math.ceil(boxHeight * scale);

      const context = canvas.getContext('2d');
      if (!context) throw new Error('El navegador no permite generar la imagen.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `barcode_${result.numeric && symbology === 'ean13' ? result.code : result.reference}.png`;
      link.click();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'No se pudo descargar la imagen.');
    }
  }

  return (
    <section>
      <h2>Código de barras</h2>
      <div className="sub">
        La referencia se coloca al inicio, se completa con ceros hasta 12 dígitos y se cierra con un dígito de
        control módulo 10.
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <form onSubmit={submit}>
          <div className="row">
            <div>
              <label htmlFor="barcode-reference">Número de artículo / referencia</label>
              <input
                id="barcode-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Ej. 12345"
                autoComplete="off"
              />
            </div>
            <div className="tight">
              <button type="submit">Generar</button>
            </div>
          </div>
        </form>
      </div>

      {result && encoded && (
        <div className="panel">
          {result.numeric ? (
            <div className="grid3">
              <div>
                <label>Base (12 dígitos)</label>
                <div className="mono">{result.base}</div>
              </div>
              <div>
                <label>Dígito de control</label>
                <div>
                  <span className="badge ok mono">{result.checkDigit}</span>
                </div>
              </div>
              <div>
                <label>Código completo (13 dígitos)</label>
                <div className="mono">{result.code}</div>
              </div>
            </div>
          ) : (
            <div className="alert info">
              La referencia contiene letras: EAN-13 solo codifica dígitos, así que se genera en CODE128.
            </div>
          )}

          <div className="grid2" style={{ marginTop: 16 }}>
            <div>
              <label htmlFor="barcode-symbology">Simbología</label>
              <select
                id="barcode-symbology"
                value={symbology}
                onChange={(event) => {
                  setSymbology(event.target.value);
                  setDownloadError(null);
                }}
              >
                <option value="ean13" disabled={!result.numeric}>
                  EAN-13
                </option>
                <option value="code128">CODE128</option>
              </select>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Usá EAN-13 para lectores de retail; CODE128 cuando la referencia no sea numérica.
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16, background: '#fff', padding: '10px 0' }}>
            <BarcodeSvg
              svgRef={svgRef}
              bars={encoded.geometry.bars}
              modules={encoded.geometry.modules}
              quietLeft={encoded.quietLeft}
              quietRight={encoded.quietRight}
              humanText={encoded.humanText}
              label={encoded.label}
            />
          </div>

          {downloadError && <div className="alert error">{downloadError}</div>}

          <div className="actions">
            <button type="button" className="btn-sm" onClick={downloadPng}>
              Descargar PNG
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
