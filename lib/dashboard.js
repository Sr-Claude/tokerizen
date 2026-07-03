'use strict';

// HTML del dashboard (auto-escrito en public/dashboard.html al arrancar el servidor).
// Autocontenido: sin CDNs ni recursos externos; el JS cliente usa concatenación
// (no template literals) para poder vivir dentro de este template literal sin escapes.

module.exports = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Claude Token Optimizer v3.4</title>
<style>
  :root {
    --page: #0d0e1c;
    --surface: #16172a;
    --surface-2: #1d1f36;
    --border: rgba(255,255,255,0.08);
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-muted: #898781;
    --grid: #2c2c3a;
    --accent: #ff6b35;
    --accent-2: #ff3366;
    --series-1: #3987e5; /* validado ≥3:1 sobre --surface */
    --series-2: #199e70; /* validado ≥3:1 sobre --surface */
    --good: #0ca30c;
    --critical: #d03b3b;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page); color: var(--ink-2);
    padding: 24px 20px 48px; min-height: 100vh;
  }
  .container { max-width: 1180px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-bottom: 22px; }
  h1 {
    font-size: 1.7em; color: var(--ink); letter-spacing: -0.02em;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .subtitle { color: var(--ink-muted); font-size: 0.9em; flex-basis: 100%; margin-top: -8px; }
  .spacer { flex: 1; }
  .badge-health {
    display: inline-flex; align-items: center; gap: 7px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 5px 14px; font-size: 0.82em;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ink-muted); }
  .dot.ok { background: var(--good); }
  .dot.down { background: var(--critical); }
  .refresh-ctl { display: inline-flex; align-items: center; gap: 8px; font-size: 0.82em; color: var(--ink-muted); }
  select, input, textarea, button {
    font: inherit; color: var(--ink-2);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
  }
  select { padding: 5px 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px 16px; position: relative; overflow: hidden;
  }
  .card::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: linear-gradient(180deg, var(--accent), var(--accent-2)); opacity: 0.85;
  }
  .card h3 { font-size: 0.68em; text-transform: uppercase; letter-spacing: 1px; color: var(--ink-muted); margin-bottom: 6px; font-weight: 600; }
  .card .value { font-size: 1.65em; font-weight: 700; color: var(--ink); }
  .card .hint { font-size: 0.72em; color: var(--ink-muted); margin-top: 3px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  @media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } }
  .panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 18px; margin-bottom: 14px; min-width: 0;
  }
  .panel-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .panel h2 { font-size: 0.95em; color: var(--ink); font-weight: 600; }
  .panel .sub { font-size: 0.78em; color: var(--ink-muted); }
  .btn {
    cursor: pointer; padding: 6px 14px; border-radius: 8px; font-size: 0.85em;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--ink-2);
  }
  .btn:hover { border-color: var(--accent); color: var(--ink); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn-primary:hover { background: #ff8855; color: #fff; }
  .btn-mini { padding: 3px 10px; font-size: 0.75em; margin-left: auto; }
  .chart-host { width: 100%; height: 150px; position: relative; }
  .chart-empty { color: var(--ink-muted); font-size: 0.82em; padding: 55px 0; text-align: center; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86em; }
  th { text-align: left; color: var(--ink-muted); font-weight: 600; font-size: 0.82em; padding: 6px 8px; border-bottom: 1px solid var(--grid); }
  td { padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 0.78em; font-weight: 600; }
  .pill.on { background: rgba(12,163,12,0.15); color: #4caf50; }
  .pill.optin { background: rgba(255,255,255,0.07); color: var(--ink-muted); }
  .pill.auto { background: rgba(57,135,229,0.15); color: #6da7ec; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 0.85em; }
  .pg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 860px) { .pg-grid { grid-template-columns: 1fr; } }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .field label { font-size: 0.75em; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .field input, .field select, .field textarea { padding: 8px 10px; }
  textarea { resize: vertical; min-height: 84px; }
  .pg-out {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; min-height: 160px; white-space: pre-wrap; word-break: break-word;
    font-size: 0.88em; overflow: auto; max-height: 320px;
  }
  .pg-usage { margin-top: 8px; font-size: 0.78em; color: var(--ink-muted); display: flex; flex-wrap: wrap; gap: 14px; }
  .snippet { position: relative; margin-bottom: 12px; }
  .snippet pre {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; font-size: 0.8em; line-height: 1.5;
    font-family: ui-monospace, Consolas, monospace; color: var(--ink-2);
  }
  .snippet .btn-mini { position: absolute; top: 8px; right: 8px; }
  #tooltip {
    position: fixed; pointer-events: none; z-index: 50; display: none;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 7px 11px; font-size: 0.78em; color: var(--ink); box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  }
  #tooltip .t { color: var(--ink-muted); }
  .err { color: #e66767; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🦊 Claude Token Optimizer</h1>
    <span class="spacer"></span>
    <span class="badge-health"><span class="dot" id="healthDot"></span><span id="healthTxt">conectando…</span></span>
    <span class="refresh-ctl">
      Refresco
      <select id="refSel">
        <option value="2000">2 s</option>
        <option value="5000" selected>5 s</option>
        <option value="10000">10 s</option>
        <option value="0">pausado</option>
      </select>
    </span>
    <p class="subtitle">v3.4 — Proxy de optimización de tokens para Anthropic · Fable 5, Opus, Sonnet, Haiku · streaming + batch</p>
  </header>

  <section class="cards" id="cards"></section>

  <section class="grid2">
    <div class="panel">
      <div class="panel-head">
        <h2>Tokens ahorrados</h2><span class="sub">por intervalo de refresco</span>
        <button class="btn btn-mini" id="tglTokens">tabla</button>
      </div>
      <div class="chart-host" id="chartTokens"><div class="chart-empty">recopilando datos…</div></div>
      <div id="tblTokens" style="display:none; margin-top:10px;"></div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h2>Peticiones</h2><span class="sub">por intervalo de refresco</span>
        <button class="btn btn-mini" id="tglReqs">tabla</button>
      </div>
      <div class="chart-host" id="chartReqs"><div class="chart-empty">recopilando datos…</div></div>
      <div id="tblReqs" style="display:none; margin-top:10px;"></div>
    </div>
  </section>

  <section class="grid2">
    <div class="panel">
      <div class="panel-head"><h2>⚙️ Estado del sistema</h2></div>
      <table>
        <tr><td>Streaming (SSE)</td><td><span class="pill on">Activo</span></td></tr>
        <tr><td>Caché asimétrica</td><td><span class="pill on">Activo</span> <span class="sub">tools + system + penúltimo msg</span></td></tr>
        <tr><td>Dynamic max_tokens</td><td><span class="pill on">Activo</span> <span class="sub">respeta el techo del cliente</span></td></tr>
        <tr><td>Compresión de historial</td><td><span class="pill on">Activo</span> <span class="sub">Haiku 4.5, aislada por API key</span></td></tr>
        <tr><td>Prefill detection</td><td><span class="pill on">Activo</span> <span class="sub">omitido en Fable 5 / 4.6+</span></td></tr>
        <tr><td>Saneamiento por modelo</td><td><span class="pill auto">Automático</span> <span class="sub">thinking / sampling / prefill</span></td></tr>
        <tr><td>Tool pruning</td><td><span class="pill optin">Opt-in</span> <span class="sub mono">x-tool-pruning</span></td></tr>
        <tr><td>Anti-preamble</td><td><span class="pill optin">Opt-in</span> <span class="sub mono">x-anti-preamble</span></td></tr>
      </table>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>🗂️ Cachés de compresión</h2><span class="sub" id="cacheCount"></span></div>
      <div id="cacheTable"><p class="sub" style="padding:20px 0;">Sin cachés activas. Se crean cuando una conversación supera los 10 mensajes.</p></div>
    </div>
  </section>

  <section class="panel" id="fleetPanel" style="display:none;">
    <div class="panel-head"><h2>🤖 Flota por agente</h2><span class="sub">peticiones etiquetadas con x-agent-id (worktrees de Orca, sub-agentes…)</span></div>
    <div id="fleetTable"></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>🧪 Playground</h2><span class="sub">envía una petición de prueba a través del proxy (no-stream)</span></div>
    <div class="pg-grid">
      <div>
        <div class="field">
          <label>API key <span style="text-transform:none">(vacío = usa la key del servidor; no se guarda)</span></label>
          <input type="password" id="pgKey" placeholder="sk-ant-…" autocomplete="off">
        </div>
        <div class="field" style="flex-direction:row; gap:10px;">
          <div style="flex:1; display:flex; flex-direction:column; gap:4px;">
            <label>Modelo</label>
            <select id="pgModel">
              <option value="claude-opus-4-8" selected>claude-opus-4-8</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-haiku-4-5">claude-haiku-4-5</option>
              <option value="claude-fable-5">claude-fable-5</option>
            </select>
          </div>
          <div style="width:120px; display:flex; flex-direction:column; gap:4px;">
            <label>max_tokens</label>
            <input type="number" id="pgMax" value="300" min="1">
          </div>
        </div>
        <div class="field">
          <label>Prompt</label>
          <textarea id="pgPrompt" placeholder="Explica la relatividad en 2 frases"></textarea>
        </div>
        <button class="btn btn-primary" id="pgSend">Enviar</button>
        <span class="sub" id="pgTiming" style="margin-left:10px;"></span>
      </div>
      <div>
        <div class="pg-out" id="pgOut">La respuesta aparecerá aquí.</div>
        <div class="pg-usage" id="pgUsage"></div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>🔌 Conexión rápida</h2><span class="sub">copia y pega para conectar tus clientes</span></div>
    <div class="grid2" style="margin-bottom:0;">
      <div class="snippet">
        <p class="sub" style="margin-bottom:6px;">Claude Code — ~/.claude/settings.json</p>
        <button class="btn btn-mini" data-copy="snipCC">copiar</button>
        <pre id="snipCC"></pre>
      </div>
      <div class="snippet">
        <p class="sub" style="margin-bottom:6px;">curl — petición directa</p>
        <button class="btn btn-mini" data-copy="snipCurl">copiar</button>
        <pre id="snipCurl"></pre>
      </div>
    </div>
  </section>
</div>
<div id="tooltip"></div>

<script>
(function () {
  'use strict';
  function el(id) { return document.getElementById(id); }
  function fmt(n) { return (n == null ? 0 : n).toLocaleString('es'); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  // ---------- snippets ----------
  var origin = window.location.origin;
  el('snipCC').textContent = '{\\n  "env": {\\n    "ANTHROPIC_BASE_URL": "' + origin + '"\\n  }\\n}';
  el('snipCurl').textContent = 'curl -X POST ' + origin + '/v1/messages \\\\\\n' +
    '  -H "Content-Type: application/json" \\\\\\n' +
    '  -H "x-api-key: sk-ant-..." \\\\\\n' +
    '  -d \\'{"model":"claude-opus-4-8","max_tokens":300,"messages":[{"role":"user","content":"Hola"}]}\\'';
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    btn.onclick = function () {
      navigator.clipboard.writeText(el(btn.getAttribute('data-copy')).textContent).then(function () {
        btn.textContent = 'copiado ✓';
        setTimeout(function () { btn.textContent = 'copiar'; }, 1400);
      });
    };
  });

  // ---------- series en memoria (última hora aprox) ----------
  var MAX_POINTS = 90;
  var hist = { t: [], tokens: [], reqs: [] };
  var prev = null;
  var tooltip = el('tooltip');

  // ---------- mini-gráfica SVG (una serie por gráfica: un solo eje) ----------
  function drawSpark(hostId, values, times, color, unit) {
    var host = el(hostId);
    if (values.length < 2) return;
    var w = host.clientWidth || 500, h = 150;
    var pl = 8, pr = 54, pt = 12, pb = 20;
    var iw = w - pl - pr, ih = h - pt - pb;
    var max = 1, i;
    for (i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
    var n = values.length;
    function X(i) { return pl + i * (iw / (n - 1)); }
    function Y(v) { return pt + ih - (v / max) * ih; }
    var line = '';
    for (i = 0; i < n; i++) line += (i ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(values[i]).toFixed(1);
    var area = line + ' L' + X(n - 1).toFixed(1) + ' ' + (pt + ih) + ' L' + pl + ' ' + (pt + ih) + ' Z';
    var mid = pt + ih / 2;
    var svg = '<svg width="' + w + '" height="' + h + '" style="display:block">' +
      '<line x1="' + pl + '" y1="' + mid + '" x2="' + (pl + iw) + '" y2="' + mid + '" stroke="var(--grid)" stroke-width="1"/>' +
      '<line x1="' + pl + '" y1="' + (pt + ih) + '" x2="' + (pl + iw) + '" y2="' + (pt + ih) + '" stroke="var(--grid)" stroke-width="1"/>' +
      '<path d="' + area + '" fill="' + color + '" fill-opacity="0.13"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"/>' +
      '<line class="xh" x1="0" y1="' + pt + '" x2="0" y2="' + (pt + ih) + '" stroke="var(--ink-muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>' +
      '<circle class="pt" r="4" fill="' + color + '" stroke="var(--surface)" stroke-width="2" style="display:none"/>' +
      '<circle cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(values[n - 1]).toFixed(1) + '" r="4" fill="' + color + '" stroke="var(--surface)" stroke-width="2"/>' +
      '<text x="' + (X(n - 1) + 8).toFixed(1) + '" y="' + (Y(values[n - 1]) + 4).toFixed(1) + '" fill="var(--ink-2)" font-size="11" font-variant-numeric="tabular-nums">' + fmt(values[n - 1]) + '</text>' +
      '</svg>';
    host.innerHTML = svg;
    var svgEl = host.firstChild, xh = svgEl.querySelector('.xh'), pmark = svgEl.querySelector('.pt');
    host.onmousemove = function (ev) {
      var r = host.getBoundingClientRect();
      var mx = ev.clientX - r.left;
      var idx = Math.round((mx - pl) / (iw / (n - 1)));
      if (idx < 0) idx = 0; if (idx > n - 1) idx = n - 1;
      var px = X(idx), py = Y(values[idx]);
      xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.style.display = '';
      pmark.setAttribute('cx', px); pmark.setAttribute('cy', py); pmark.style.display = '';
      tooltip.style.display = 'block';
      tooltip.innerHTML = '<span class="t">' + times[idx] + '</span><br><b>' + fmt(values[idx]) + '</b> ' + unit;
      var tx = ev.clientX + 14, ty = ev.clientY - 12;
      if (tx + 160 > window.innerWidth) tx = ev.clientX - 160;
      tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    };
    host.onmouseleave = function () {
      xh.style.display = 'none'; pmark.style.display = 'none'; tooltip.style.display = 'none';
    };
  }

  function renderTable(hostId, values, times, unit) {
    var rows = '', start = Math.max(0, values.length - 12);
    for (var i = values.length - 1; i >= start; i--) {
      rows += '<tr><td>' + times[i] + '</td><td class="num">' + fmt(values[i]) + ' ' + unit + '</td></tr>';
    }
    el(hostId).innerHTML = '<table><tr><th>Hora</th><th class="num">Valor</th></tr>' + rows + '</table>';
  }

  el('tglTokens').onclick = function () { toggleTbl('tblTokens', hist.tokens, 'tokens', this); };
  el('tglReqs').onclick = function () { toggleTbl('tblReqs', hist.reqs, 'peticiones', this); };
  function toggleTbl(id, values, unit, btn) {
    var d = el(id);
    if (d.style.display === 'none') { renderTable(id, values, hist.t, unit); d.style.display = ''; btn.textContent = 'gráfica'; }
    else { d.style.display = 'none'; btn.textContent = 'tabla'; }
  }

  // ---------- polling ----------
  function refresh() {
    Promise.all([
      fetch('/stats').then(function (r) { return r.json(); }),
      fetch('/health').then(function (r) { return r.json(); }),
    ]).then(function (res) {
      var d = res[0], hlt = res[1];

      var dot = el('healthDot');
      dot.className = 'dot ' + (hlt.status === 'ok' ? 'ok' : 'down');
      el('healthTxt').textContent = hlt.status === 'ok' ? 'operativo' : hlt.status;

      var upMin = Math.floor(d.uptime / 60);
      var upTxt = upMin >= 60 ? Math.floor(upMin / 60) + ' h ' + (upMin % 60) + ' min' : upMin + ' min';
      var cards = [
        ['Peticiones', fmt(d.totalRequests), ''],
        ['Tokens ahorrados', fmt(d.totalTokensSaved), 'estimado'],
        ['Ahorro USD', '$' + d.estimatedSavingsUSD, 'precio real por modelo'],
        ['Gasto USD', '$' + (d.totalSpentUSD || 0), 'Claude, estimado'],
        ['Resp. cacheadas', fmt(d.totalResponseCacheHits || 0), 'x-cache-response'],
        ['Cachés activas', fmt(d.activeCaches), 'compresión'],
        ['Batch calls', fmt(d.totalBatchCalls), ''],
        ['Compresiones', fmt(d.totalCompressions), ''],
        ['Uptime', upTxt, ''],
        ['Memoria', (d.memoryUsage.heapUsed / 1048576).toFixed(1) + ' MB', 'heap'],
      ];
      el('cards').innerHTML = cards.map(function (c) {
        return '<div class="card"><h3>' + c[0] + '</h3><div class="value">' + c[1] + '</div>' +
          (c[2] ? '<div class="hint">' + c[2] + '</div>' : '') + '</div>';
      }).join('');

      // deltas por intervalo
      if (prev) {
        var now = new Date();
        var hh = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) + ':' + ('0' + now.getSeconds()).slice(-2);
        hist.t.push(hh);
        hist.tokens.push(Math.max(0, d.totalTokensSaved - prev.totalTokensSaved));
        hist.reqs.push(Math.max(0, d.totalRequests - prev.totalRequests));
        if (hist.t.length > MAX_POINTS) { hist.t.shift(); hist.tokens.shift(); hist.reqs.shift(); }
        drawSpark('chartTokens', hist.tokens, hist.t, 'var(--series-1)', 'tokens');
        drawSpark('chartReqs', hist.reqs, hist.t, 'var(--series-2)', 'peticiones');
      }
      prev = d;

      // flota por agente (x-agent-id)
      var agentIds = d.agents ? Object.keys(d.agents) : [];
      if (agentIds.length) {
        el('fleetPanel').style.display = '';
        var frows = agentIds.map(function (id) {
          var a = d.agents[id];
          var provs = a.providers ? Object.keys(a.providers).join(', ') : 'anthropic';
          return '<tr><td class="mono">' + esc(id) + '</td>' +
            '<td>' + esc(provs) + '</td>' +
            '<td class="num">' + fmt(a.requests) + '</td>' +
            '<td class="num">' + fmt(a.inputTokens) + ' / ' + fmt(a.outputTokens) + '</td>' +
            '<td class="num">$' + (a.spentUSD || 0).toFixed(4) + '</td>' +
            '<td class="num">' + fmt(a.savedTokens) + '</td></tr>';
        }).join('');
        el('fleetTable').innerHTML = '<table><tr><th>Agente</th><th>Proveedores</th>' +
          '<th class="num">Peticiones</th><th class="num">Tokens in/out</th>' +
          '<th class="num">Gasto</th><th class="num">Tokens ahorrados</th></tr>' + frows + '</table>';
      } else {
        el('fleetPanel').style.display = 'none';
      }

      // cachés
      el('cacheCount').textContent = d.activeCaches ? d.activeCaches + ' activas' : '';
      if (d.cacheEntries && d.cacheEntries.length) {
        var rows = d.cacheEntries.map(function (c) {
          return '<tr><td class="mono">' + esc(String(c.convId).slice(-18)) + '</td>' +
            '<td class="num">' + Math.round(c.age / 1000) + ' s</td>' +
            '<td class="num">' + fmt(c.summaryLength) + ' chars</td></tr>';
        }).join('');
        el('cacheTable').innerHTML = '<table><tr><th>Conversación</th><th class="num">Edad</th><th class="num">Resumen</th></tr>' + rows + '</table>';
      } else {
        el('cacheTable').innerHTML = '<p class="sub" style="padding:20px 0;">Sin cachés activas. Se crean cuando una conversación supera los 10 mensajes.</p>';
      }
    }).catch(function () {
      el('healthDot').className = 'dot down';
      el('healthTxt').textContent = 'sin conexión';
    });
  }

  // refresco configurable + pausa cuando la pestaña no es visible
  var timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    var ms = parseInt(el('refSel').value, 10);
    if (ms > 0) timer = setInterval(function () { if (!document.hidden) refresh(); }, ms);
  }
  el('refSel').onchange = schedule;
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  window.addEventListener('resize', function () {
    if (hist.t.length > 1) {
      drawSpark('chartTokens', hist.tokens, hist.t, 'var(--series-1)', 'tokens');
      drawSpark('chartReqs', hist.reqs, hist.t, 'var(--series-2)', 'peticiones');
    }
  });
  refresh();
  schedule();

  // ---------- playground ----------
  el('pgSend').onclick = function () {
    var btn = this, out = el('pgOut'), usage = el('pgUsage');
    var prompt = el('pgPrompt').value.trim();
    if (!prompt) { out.textContent = 'Escribe un prompt primero.'; return; }
    var headers = { 'content-type': 'application/json' };
    var key = el('pgKey').value.trim();
    if (key) headers['x-api-key'] = key;
    btn.disabled = true; btn.textContent = 'Enviando…';
    out.textContent = ''; usage.textContent = ''; el('pgTiming').textContent = '';
    var t0 = performance.now();
    fetch('/v1/messages', {
      method: 'POST', headers: headers,
      body: JSON.stringify({
        model: el('pgModel').value,
        max_tokens: parseInt(el('pgMax').value, 10) || 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, headers: r.headers, json: j }; });
    }).then(function (res) {
      var ms = Math.round(performance.now() - t0);
      el('pgTiming').textContent = ms + ' ms';
      if (!res.ok) {
        out.innerHTML = '<span class="err">Error: ' + esc(res.json.message || JSON.stringify(res.json)) + '</span>';
        return;
      }
      var j = res.json;
      var text = (j.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('\\n');
      out.textContent = text || JSON.stringify(j, null, 2);
      var u = j.usage || {};
      var parts = [
        'entrada: ' + fmt(u.input_tokens),
        'salida: ' + fmt(u.output_tokens),
        'caché leída: ' + fmt(u.cache_read_input_tokens),
        'caché escrita: ' + fmt(u.cache_creation_input_tokens),
      ];
      if (j.stop_reason) parts.push('stop: ' + j.stop_reason);
      if (res.headers.get('x-compressed')) parts.push('comprimido ✓');
      usage.innerHTML = parts.map(function (p) { return '<span>' + esc(p) + '</span>'; }).join('');
      refresh();
    }).catch(function (e) {
      out.innerHTML = '<span class="err">Error de red: ' + esc(e.message) + '</span>';
    }).finally(function () {
      btn.disabled = false; btn.textContent = 'Enviar';
    });
  };
})();
</script>
</body>
</html>`;
