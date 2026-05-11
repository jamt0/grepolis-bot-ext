/* features/mercadoOro.js — alarma + tab "Oro" en el panel principal.
 *
 * Pollea `PremiumExchange:read` cada 60s en una ciudad representante por mar
 * y dispara alarma persistente cuando `capacity - stock ≥ UMBRAL` en
 * wood/stone/iron de algún mar. El usuario silencia la alarma con un botón
 * que aparece junto a Jam▶ solo durante la alarma.
 *
 * Estrategia "1 ciudad por mar":
 *   - Primera ronda: 1 request por ciudad para mapear `sea_id → townId`. El
 *     mapa se persiste en chrome.storage.local namespaceado por mundo.
 *   - Régimen estable: poll solo a representantes.
 *   - Re-descubrimiento cada 30 min.
 *
 * Persistencia (toda namespaceada por world_id):
 *   - mapa sea_id → townId representante
 *   - últimas POLLS_MAX entradas (12h a 1/min) con diff por recurso/mar
 *   - últimas ALERTAS_MAX (100) alertas disparadas
 *
 * UI: NO tiene botón propio para abrir panel — está integrada como tab "Oro"
 * del panel #panelConfigJam, que recoleccion.js delega vía
 * JamBot.features.mercadoOro.api.renderTab(body). El único botón propio es
 * "🔔 Revisé oro" en jambot-buttons, que aparece solo cuando hay alarma.
 *
 * Independiente del play/pause del bot — el monitor sigue corriendo aunque el
 * bot esté pausado. SÍ respeta CAPTCHA.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  const POLL_INTERVAL_MS = 20 * 1000;
  const REDESCUBRIR_INTERVAL_MS = 30 * 60 * 1000;
  const UMBRAL = 100;
  const BEEP_INTERVAL_MS = 700;
  const RECURSOS = ["wood", "stone", "iron"];
  const ALERTAS_MAX = 100;

  const COLOR_RECURSO = { wood: "#c39a55", stone: "#bdc3c7", iron: "#95a5a6" };
  const LABEL_RECURSO = { wood: "Madera", stone: "Piedra", iron: "Hierro" };

  async function init(ctx) {
    const { game, core } = ctx;
    const { csrfToken, world_id, townId } = game;

    const STORAGE_KEY_MAPA = `jambotMercadoOroMapa_${world_id}`;
    const STORAGE_KEY_ALERTAS = `jambotMercadoOroAlertas_${world_id}`;

    let mapaSeaIdToTown = {};
    let ultimoDescubrimiento = 0;
    //estadoActual[seaId] = {townId, ts, wood:{stock,capacity,diff}, stone:..., iron:...}
    let estadoActual = {};
    //alertas[] = {ts, seaId, items:[{r,diff,stock,capacity}]}. Rotatorio.
    let alertas = [];

    let alarmaActiva = false;
    let beepIntervalId = null;
    let flashIntervalId = null;
    let tituloOriginal = null;
    let audioCtx = null;

    //—— Persistencia ————————————————————————————————————————————————————
    async function cargarStorage() {
      try {
        const obj = await new Promise((resolve) => {
          chrome.storage.local.get(
            [STORAGE_KEY_MAPA, STORAGE_KEY_ALERTAS],
            (o) => resolve(o || {})
          );
        });
        const guardadoMapa = obj[STORAGE_KEY_MAPA];
        if (guardadoMapa && typeof guardadoMapa === "object") {
          mapaSeaIdToTown = guardadoMapa.mapa || {};
          ultimoDescubrimiento = guardadoMapa.ts || 0;
          //Migración del shape viejo `sea_id → townId(number)` al nuevo
          //`sea_id → {id, name}`. Si detecto el formato viejo, normalizo a
          //objeto sin nombre y fuerzo re-descubrimiento para repoblar el
          //nombre desde la collection Towns.
          let necesitaMigrar = false;
          for (const k of Object.keys(mapaSeaIdToTown)) {
            const v = mapaSeaIdToTown[k];
            if (typeof v === "number") {
              mapaSeaIdToTown[k] = { id: v, name: null };
              necesitaMigrar = true;
            }
          }
          if (necesitaMigrar) ultimoDescubrimiento = 0;
        }
        if (Array.isArray(obj[STORAGE_KEY_ALERTAS])) alertas = obj[STORAGE_KEY_ALERTAS];
        const n = Object.keys(mapaSeaIdToTown).length;
        if (n > 0) {
          core.log(
            "mercadoOro",
            `mapa ${n} mar(es) cargado · ${alertas.length} alertas`,
            "ok"
          );
        }
      } catch (_) { /* sin storage */ }
    }

    function persistirMapa() {
      try {
        chrome.storage.local.set({
          [STORAGE_KEY_MAPA]: { mapa: mapaSeaIdToTown, ts: ultimoDescubrimiento },
        });
      } catch (_) {}
    }
    let saveAlertasTimer = null;
    function persistirAlertas() {
      if (saveAlertasTimer) return;
      saveAlertasTimer = setTimeout(() => {
        saveAlertasTimer = null;
        try { chrome.storage.local.set({ [STORAGE_KEY_ALERTAS]: alertas }); } catch (_) {}
      }, 1000);
    }

    await cargarStorage();

    //—— Botón de alarma ————————————————————————————————————————————————
    //
    //Único botón propio. Aparece solo durante alarma — el panel se abre
    //desde Jam▶ y el tab "Oro" se registra desde recoleccion.js.
    const botonAlarma = core.registrarBoton({
      id: "jambot-oro-confirm",
      label: "🔔 Revisé oro",
      onClick: () => detenerAlarma(),
    });
    botonAlarma.el.style.display = "none";
    botonAlarma.setStyle({ bg: "#f1c40f", fg: "#1a1a1a" });

    //—— Alarma ——————————————————————————————————————————————————————————
    function dispararAlarma(items) {
      if (alarmaActiva) return;
      alarmaActiva = true;
      const resumen = items.map((x) => `mar ${x.seaId} ${x.recurso} ${x.diff}`).join(" | ");
      core.logWarn("mercadoOro", `ORO DISPONIBLE — ${resumen}`);

      //Agrupar por mar para guardar 1 entrada de alerta por mar (no 1 por
      //recurso): el panel muestra "Mar X: Madera 120 · Piedra 150" más
      //prolijo que tres entradas separadas con el mismo timestamp.
      const porMar = new Map();
      for (const x of items) {
        if (!porMar.has(x.seaId)) porMar.set(x.seaId, []);
        porMar.get(x.seaId).push({ r: x.recurso, diff: x.diff, stock: x.stock, capacity: x.capacity });
      }
      const ahora = Date.now();
      for (const [seaId, lista] of porMar.entries()) {
        alertas.push({ ts: ahora, seaId: Number(seaId), items: lista });
      }
      while (alertas.length > ALERTAS_MAX) alertas.shift();
      persistirAlertas();

      botonAlarma.setLabel(`🔔 Oro: ${resumen}`);
      botonAlarma.el.style.display = "";

      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
      } catch (e) {
        core.logWarn("mercadoOro", "AudioContext no disponible — alarma solo visual");
        audioCtx = null;
      }
      const beep = () => {
        if (!audioCtx) return;
        try {
          //Square wave 1400Hz, attack/release cortos: cada beep "puntudo"
          //para que el cerebro no lo filtre como tono ambiente.
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.connect(g);
          g.connect(audioCtx.destination);
          o.type = "square";
          o.frequency.value = 1400;
          const t = audioCtx.currentTime;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.18, t + 0.02);
          g.gain.linearRampToValueAtTime(0, t + 0.32);
          o.start(t);
          o.stop(t + 0.35);
        } catch (_) {}
      };
      beep();
      beepIntervalId = setInterval(beep, BEEP_INTERVAL_MS);

      if (tituloOriginal == null) tituloOriginal = document.title;
      let on = false;
      flashIntervalId = setInterval(() => {
        on = !on;
        document.title = on ? "🔔 ORO — JamBot" : tituloOriginal;
      }, 800);
    }

    function detenerAlarma() {
      if (!alarmaActiva) return;
      alarmaActiva = false;
      core.log("mercadoOro", "alarma confirmada por usuario", "ok");
      botonAlarma.el.style.display = "none";
      botonAlarma.setLabel("🔔 Revisé oro");
      if (beepIntervalId) { clearInterval(beepIntervalId); beepIntervalId = null; }
      if (flashIntervalId) {
        clearInterval(flashIntervalId);
        flashIntervalId = null;
        if (tituloOriginal != null) {
          document.title = tituloOriginal;
          tituloOriginal = null;
        }
      }
      if (audioCtx) {
        try { audioCtx.close(); } catch (_) {}
        audioCtx = null;
      }
    }

    //—— Requests ————————————————————————————————————————————————————————
    async function leerPremiumExchange(repTownId) {
      const json = JSON.stringify({
        model_url: "PremiumExchange",
        action_name: "read",
        town_id: repTownId,
        nl_init: true,
      });
      const url =
        `https://${world_id}.grepolis.com/game/frontend_bridge` +
        `?town_id=${repTownId}&action=execute&h=${csrfToken}` +
        `&json=${encodeURIComponent(json)}&_=${Date.now()}`;
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "text/plain, */*; q=0.01",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    async function obtenerCiudades() {
      const url =
        `https://${world_id}.grepolis.com/game/frontend_bridge` +
        `?town_id=${townId}&action=refetch&h=${csrfToken}` +
        `&json={"collections":{"Towns":[]},"town_id":${townId},"nl_init":false}`;
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "text/plain, */*; q=0.01",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items =
        (data && data.json && data.json.collections && data.json.collections.Towns &&
          data.json.collections.Towns.data) || [];
      return items.map((it) => it.d || it).filter((c) => c && c.id);
    }

    function procesarPayload(seaId, repTown, payloadJson, ts) {
      if (!payloadJson) return [];
      const entry = { townId: repTown.id, townName: repTown.name, ts };
      const dispara = [];
      for (const k of RECURSOS) {
        const r = payloadJson[k];
        if (!r) continue;
        const stock = r.stock || 0;
        const capacity = r.capacity || 0;
        const diff = capacity - stock;
        entry[k] = { stock, capacity, diff };
        if (diff >= UMBRAL) {
          dispara.push({ seaId: Number(seaId), recurso: k, diff, stock, capacity });
        }
      }
      estadoActual[seaId] = entry;
      return dispara;
    }

    //—— Descubrimiento ————————————————————————————————————————————————
    async function descubrirMares() {
      core.log("mercadoOro", "descubriendo mapa de mares (1 req por ciudad)…");
      let ciudades;
      try {
        ciudades = await obtenerCiudades();
      } catch (e) {
        core.logError("mercadoOro", "no pude obtener lista de ciudades", e);
        return;
      }
      if (!ciudades.length) {
        core.logWarn("mercadoOro", "lista de ciudades vacía");
        return;
      }

      const nuevoMapa = {};
      const acumulado = [];
      const ts = Date.now();
      for (const c of ciudades) {
        if (!core.isExtensionContextValid()) return;
        if (core.isCaptchaActive()) {
          core.logWarn("mercadoOro", "descubrimiento abortado por CAPTCHA");
          return;
        }
        try {
          const data = await leerPremiumExchange(c.id);
          const j = data && data.json;
          const seaId = j && j.sea_id;
          if (seaId == null) continue;
          if (nuevoMapa[seaId] == null) {
            nuevoMapa[seaId] = { id: c.id, name: c.name || null };
            acumulado.push(...procesarPayload(seaId, nuevoMapa[seaId], j, ts));
          }
          await core.delaySeconds(0.3 + Math.random() * 0.3);
        } catch (e) {
          core.logWarn("mercadoOro", `descubrir ciudad ${c.id} (${c.name}): ${e.message}`);
        }
      }
      mapaSeaIdToTown = nuevoMapa;
      ultimoDescubrimiento = Date.now();
      persistirMapa();
      core.log(
        "mercadoOro",
        `mapa actualizado: ${Object.keys(nuevoMapa).length} mar(es) ${JSON.stringify(nuevoMapa)}`,
        "ok"
      );
      if (acumulado.length && !alarmaActiva) dispararAlarma(acumulado);
    }

    //—— Ciclo ————————————————————————————————————————————————————————
    async function ciclo() {
      if (!core.isExtensionContextValid()) return;
      if (core.isCaptchaActive()) return;

      const ahora = Date.now();
      const sinMapa = Object.keys(mapaSeaIdToTown).length === 0;
      const expirado = ahora - ultimoDescubrimiento >= REDESCUBRIR_INTERVAL_MS;
      if (sinMapa || expirado) {
        await descubrirMares();
        return;
      }

      const acumulado = [];
      const ts = Date.now();
      for (const [seaId, repTown] of Object.entries(mapaSeaIdToTown)) {
        if (!core.isExtensionContextValid()) return;
        if (core.isCaptchaActive()) return;
        try {
          const data = await leerPremiumExchange(repTown.id);
          acumulado.push(...procesarPayload(seaId, repTown, data && data.json, ts));
          await core.delaySeconds(0.3 + Math.random() * 0.3);
        } catch (e) {
          core.logWarn("mercadoOro", `poll mar ${seaId} (town ${repTown.id}): ${e.message}`);
        }
      }
      if (acumulado.length && !alarmaActiva) dispararAlarma(acumulado);
    }

    //—— Render del tab "Oro" ————————————————————————————————————————————
    //
    //Self-contained — los estilos imitan a renderTab de ataques.js para que
    //la tab se sienta parte del panel: cards en #172029 con border #2c3a4d,
    //texto #e6e9ee/#7a8aa0, subtítulos en mayúsculas con tracking.
    //Recoleccion lo invoca cada segundo mientras el tab está visible.

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[c]);
    }

    function fmtTiempoRel(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return `hace ${s}s`;
      if (s < 3600) return `hace ${Math.floor(s / 60)}m ${s % 60}s`;
      return `hace ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }

    function fmtHora(ms) {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function colorDiff(diff) {
      if (diff == null) return "#5a6776";
      if (diff >= UMBRAL) return "#e74c3c";
      if (diff >= UMBRAL * 0.5) return "#f1c40f";
      return "#27ae60";
    }

    function renderHeader() {
      const mares = Object.keys(mapaSeaIdToTown).length;
      const wrap = document.createElement("div");
      const corriendo = !core.isCaptchaActive();
      wrap.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 12px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${alarmaActiva ? "#e74c3c" : (corriendo ? "#27ae60" : "#7a8aa0")}`;
      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const titulo = document.createElement("div");
      titulo.textContent = "Monitor de mercado de oro";
      titulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const sub = document.createElement("div");
      sub.textContent = alarmaActiva
        ? "🔔 ALARMA ACTIVA — apretá '🔔 Revisé oro' para silenciar"
        : corriendo
          ? `Activo · revisa cada ${POLL_INTERVAL_MS / 1000}s · alerta si hay ≥${UMBRAL} de espacio para vender · ${mares} mar(es) · ${alertas.length} alertas`
          : "En espera — CAPTCHA activo";
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      left.appendChild(titulo);
      left.appendChild(sub);
      wrap.appendChild(left);
      return wrap;
    }

    function renderExplicacion(texto) {
      const v = document.createElement("div");
      v.innerHTML = texto;
      v.style.cssText =
        "background:#1a232e;border-left:3px solid #3498db;color:#bdc3c7;" +
        "padding:8px 10px;font-size:11.5px;line-height:1.45;border-radius:3px;" +
        "margin-bottom:8px";
      return v;
    }

    function renderSubtitulo(text) {
      const s = document.createElement("div");
      s.textContent = text;
      s.style.cssText =
        "font-size:10.5px;font-weight:bold;margin:14px 0 8px;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      return s;
    }

    function renderTablaEstado() {
      const mares = Object.keys(mapaSeaIdToTown).sort((a, b) => Number(a) - Number(b));
      if (!mares.length) {
        const v = document.createElement("div");
        v.textContent = "Esperando primer descubrimiento de mares…";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11.5px;padding:6px 0";
        return v;
      }
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;overflow:hidden";
      const head = `
        <tr style="background:#1a232e;color:#7a8aa0;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px">
          <th style="padding:6px 10px;text-align:left">Mar</th>
          <th style="padding:6px 10px;text-align:left">Ciudad consultada</th>
          <th style="padding:6px 10px;text-align:right" title="Espacio = capacity − stock. Cuánta madera podés vender al mercado de este mar para recibir oro.">Madera<br><span style="font-size:9px;color:#5a6776;text-transform:none;letter-spacing:0">espacio p/vender</span></th>
          <th style="padding:6px 10px;text-align:right" title="Espacio = capacity − stock. Cuánta piedra podés vender al mercado de este mar para recibir oro.">Piedra<br><span style="font-size:9px;color:#5a6776;text-transform:none;letter-spacing:0">espacio p/vender</span></th>
          <th style="padding:6px 10px;text-align:right" title="Espacio = capacity − stock. Cuánto hierro podés vender al mercado de este mar para recibir oro.">Hierro<br><span style="font-size:9px;color:#5a6776;text-transform:none;letter-spacing:0">espacio p/vender</span></th>
          <th style="padding:6px 10px;text-align:right">Actualizado</th>
        </tr>
      `;
      let rows = "";
      for (const seaId of mares) {
        const e = estadoActual[seaId];
        if (!e) {
          rows += `<tr><td colspan="6" style="padding:8px 10px;color:#7a8aa0;font-size:11px;font-style:italic;border-top:1px solid #2c3a4d">mar ${seaId}: sin datos aún</td></tr>`;
          continue;
        }
        const cell = (rec) => {
          const v = e[rec];
          if (!v) return `<td style="padding:8px 10px;text-align:right;color:#5a6776">—</td>`;
          return `<td style="padding:8px 10px;text-align:right;color:${colorDiff(v.diff)};font-weight:bold;font-family:monospace" title="stock ${v.stock} / capacity ${v.capacity} — podés vender hasta ${v.diff} para recibir oro">${v.diff}</td>`;
        };
        //Nombre de la ciudad si lo tenemos (del último descubrimiento);
        //fallback al ID en monospace si todavía no se pobló (puede pasar tras
        //una migración del shape viejo del mapa, antes del re-descubrimiento).
        const ciudad = e.townName
          ? `<span style="color:#e6e9ee">${escapeHtml(e.townName)}</span> <span style="color:#5a6776;font-family:monospace;font-size:10.5px">#${e.townId}</span>`
          : `<span style="color:#bdc3c7;font-family:monospace">#${e.townId}</span>`;
        rows += `
          <tr style="border-top:1px solid #2c3a4d;font-size:12px">
            <td style="padding:8px 10px;color:#e6e9ee;font-weight:bold">${seaId}</td>
            <td style="padding:8px 10px">${ciudad}</td>
            ${cell("wood")}${cell("stone")}${cell("iron")}
            <td style="padding:8px 10px;text-align:right;color:#7a8aa0;font-size:11px">${fmtTiempoRel(e.ts)}</td>
          </tr>
        `;
      }
      wrap.innerHTML = `<table style="width:100%;border-collapse:collapse">${head}${rows}</table>`;
      return wrap;
    }

    function renderCharts() {
      const mares = Object.keys(mapaSeaIdToTown).sort((a, b) => Number(a) - Number(b));
      if (!mares.length) return null;
      const wrap = document.createElement("div");
      const leyenda = document.createElement("div");
      leyenda.style.cssText = "display:flex;gap:14px;margin-bottom:8px;font-size:11px";
      leyenda.innerHTML = `
        <span style="color:${COLOR_RECURSO.wood}">■ ${LABEL_RECURSO.wood}</span>
        <span style="color:${COLOR_RECURSO.stone}">■ ${LABEL_RECURSO.stone}</span>
        <span style="color:${COLOR_RECURSO.iron}">■ ${LABEL_RECURSO.iron}</span>
        <span style="color:#e74c3c;margin-left:auto">- - umbral ${UMBRAL}</span>
      `;
      wrap.appendChild(leyenda);
      for (const seaId of mares) {
        const card = document.createElement("div");
        card.style.cssText =
          "background:#172029;border:1px solid #2c3a4d;border-radius:4px;padding:8px 10px;margin-bottom:6px";
        card.innerHTML = `
          <div style="font-size:11px;color:#bdc3c7;font-weight:bold;margin-bottom:4px">Mar ${seaId}</div>
          ${chartSVG(seaId)}
        `;
        wrap.appendChild(card);
      }
      return wrap;
    }

    function renderAlertas() {
      const wrap = document.createElement("div");
      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;margin:14px 0 8px";
      const subt = document.createElement("div");
      subt.textContent = "HISTORIAL DE ALERTAS";
      subt.style.cssText =
        "flex:1;font-size:10.5px;font-weight:bold;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      head.appendChild(subt);
      if (alertas.length) {
        const clr = document.createElement("button");
        clr.textContent = "limpiar";
        clr.style.cssText =
          "margin-left:8px;background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 10px;" +
          "cursor:pointer;border-radius:3px;font-size:11px;font-weight:bold";
        clr.addEventListener("click", () => {
          if (!confirm("¿Borrar el historial de alertas?")) return;
          alertas = [];
          persistirAlertas();
          //re-render — recoleccion vuelve a llamar renderTab cada segundo,
          //pero también gatillamos uno inmediato por feedback instantáneo.
          const body = document.querySelector("#panelConfigJam .pcj-body");
          if (body) renderTab(body);
        });
        head.appendChild(clr);
      }
      wrap.appendChild(head);

      if (!alertas.length) {
        const v = document.createElement("div");
        v.textContent = "Sin alertas registradas.";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11.5px;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const lista = document.createElement("div");
      lista.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        "max-height:240px;overflow-y:auto";
      let html = "";
      const ordenadas = alertas.slice().reverse();
      for (const a of ordenadas) {
        const items = a.items
          .map((it) => {
            const label = escapeHtml(LABEL_RECURSO[it.r] || it.r);
            return `<span style="color:${COLOR_RECURSO[it.r]}">${label}</span> <b style="color:${colorDiff(it.diff)};font-family:monospace">${it.diff}</b><span style="color:#5a6776"> (${it.stock}/${it.capacity})</span>`;
          })
          .join(" · ");
        html += `
          <div style="padding:6px 10px;border-top:1px solid #2c3a4d;font-size:12px">
            <span style="color:#7a8aa0;font-family:monospace;font-size:11px">${fmtHora(a.ts)}</span>
            <b style="margin:0 8px;color:#e6e9ee">Mar ${a.seaId}</b>
            ${items}
          </div>
        `;
      }
      lista.innerHTML = html;
      wrap.appendChild(lista);
      return wrap;
    }

    function renderTab(body) {
      body.innerHTML = "";
      body.appendChild(renderHeader());

      body.appendChild(renderSubtitulo("Estado actual por mar"));
      body.appendChild(renderExplicacion(
        `El mercado de oro funciona <b>por mar</b> — todas las ciudades del mismo mar comparten el mismo stock. ` +
        `Los números de cada recurso son <b>capacity − stock</b>: cuánto de ese recurso podés <b>venderle al mercado</b> ` +
        `para recibir <b style="color:#f1c40f">oro premium</b>. Verde &lt;50, amarillo 50–99, rojo ≥${UMBRAL} (dispara la alarma). ` +
        `Solo se consulta <b>una ciudad por mar</b> (la "ciudad consultada" de la tabla), porque el resto repetiría el mismo dato.`
      ));
      body.appendChild(renderTablaEstado());

      body.appendChild(renderAlertas());
    }

    //—— Arranque ———————————————————————————————————————————————————————
    setInterval(() => {
      ciclo().catch((e) => core.logError("mercadoOro", "ciclo falló", e));
    }, POLL_INTERVAL_MS);
    ciclo().catch((e) => core.logError("mercadoOro", "ciclo inicial falló", e));

    core.log(
      "mercadoOro",
      `iniciado (poll cada ${POLL_INTERVAL_MS / 1000}s, umbral=${UMBRAL}, re-descubrir cada ${REDESCUBRIR_INTERVAL_MS / 60000}min)`,
      "ok"
    );

    JamBot.features.mercadoOro.api = { renderTab };
  }

  JamBot.features.mercadoOro = { init };
})();
