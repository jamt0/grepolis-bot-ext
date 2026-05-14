/* features/ataquesEntrantes.js — alarma persistente para ataques entrantes.
 *
 * Pollea cada 10s el endpoint `town_overviews:command_overview` (una sola
 * request da la vista global de TODAS mis ciudades — los `commands` que
 * devuelve incluyen origen y destino en toda la cuenta). Filtra los que
 * cumplen la regla del cliente del juego para "incoming attack":
 *
 *   !cmd.return && attack_types[cmd.type] && cmd.destination_town_player_id == me
 *
 * Si aparece un id nuevo no acknowledgeado, dispara alarma sostenida
 * (beep + flash de título) que NO para hasta que el usuario apriete el
 * botón "🔔 Revisé ataques". Silenciar marca los ids actuales como ack —
 * si luego entra OTRO ataque nuevo, vuelve a sonar.
 *
 * Persistencia (namespaceada por world_id):
 *   - set de ids ack (sobrevive a reload; se purga cuando el id desaparece
 *     del listado del server, o sea cuando el ataque llegó o fue cancelado)
 *   - historial de últimas N alarmas disparadas
 *
 * Tab "Defensa" del panel: muestra los ataques entrantes actuales con
 * countdown a la llegada y un historial. Recoleccion lo invoca cada
 * segundo via JamBot.features.ataquesEntrantes.api.renderTab(body).
 *
 * Independiente del play/pause del bot — la detección sigue corriendo
 * aunque el bot esté pausado. SÍ respeta CAPTCHA (no spamea fetch).
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  const POLL_INTERVAL_MS = 10 * 1000;
  const BEEP_INTERVAL_MS = 700;
  const HISTORIAL_MAX = 200;

  //Etiquetas en español para mostrar el tipo de ataque entrante. Si llega
  //un tipo no listado lo mostramos crudo (raro pero defensivo).
  const LABEL_TIPO = {
    attack:                 "Ataque",
    attack_land:            "Ataque terrestre",
    attack_sea:             "Ataque naval",
    attack_takeover:        "Conquista",
    revolt:                 "Revuelta",
    illusion:               "Ilusión",
    portal_attack_olympus:  "Ataque a Olimpo",
    portal_revolt_olympus:  "Revuelta a Olimpo",
  };

  //Tipos que disparan alarma roja "peligro real" vs amarilla "molestia".
  //Conquista y revuelta son las críticas: si llegan y no tenés defensa, la
  //ciudad cambia de dueño. Ataques normales bajan tropas pero la ciudad
  //sigue siendo tuya.
  const TIPO_CRITICO = new Set(["attack_takeover", "revolt"]);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  //El juego manda los nombres como anchors HTML con base64 en el href
  //(<a href="#eyJ...">Nombre</a>). Para mostrar limpio en la UI, sacamos
  //el texto interno con un parser temporal. Si falla, devolvemos crudo.
  function textoDeAnchor(html) {
    if (!html) return "";
    try {
      const d = document.createElement("div");
      d.innerHTML = String(html);
      return d.textContent || d.innerText || "";
    } catch (_) { return String(html); }
  }

  async function init(ctx) {
    const { game, core } = ctx;
    const { csrfToken, world_id, townId, player_id } = game;

    const STORAGE_KEY_ACK = `jambotAtaquesEntrantesAck_${world_id}`;
    const STORAGE_KEY_HISTORIAL = `jambotAtaquesEntrantesHistorial_${world_id}`;

    //ackIds: set de command ids que el usuario ya silenció. Sobrevive a
    //reload. Se purga in-flight cuando el id desaparece del listado del
    //server (ataque llegó o fue cancelado) — así no crece sin límite.
    let ackIds = new Set();
    let historial = [];

    //Estado runtime — no persiste, se rehidrata en cada poll.
    let ataquesActuales = [];   //[{id, type, originTownName, originPlayerName, destTownId, destTownName, arrivalAt, ...}]
    let ultimoPollTs = 0;
    let ultimoPollOk = false;
    let ultimoPollError = null;

    //Alarma
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
            [STORAGE_KEY_ACK, STORAGE_KEY_HISTORIAL],
            (o) => resolve(o || {})
          );
        });
        if (Array.isArray(obj[STORAGE_KEY_ACK])) ackIds = new Set(obj[STORAGE_KEY_ACK]);
        if (Array.isArray(obj[STORAGE_KEY_HISTORIAL])) historial = obj[STORAGE_KEY_HISTORIAL];
      } catch (_) { /* sin storage */ }
    }

    let saveAckTimer = null;
    function persistirAck() {
      if (saveAckTimer) return;
      saveAckTimer = setTimeout(() => {
        saveAckTimer = null;
        try { chrome.storage.local.set({ [STORAGE_KEY_ACK]: Array.from(ackIds) }); } catch (_) {}
      }, 500);
    }

    let saveHistTimer = null;
    function persistirHistorial() {
      if (saveHistTimer) return;
      saveHistTimer = setTimeout(() => {
        saveHistTimer = null;
        try { chrome.storage.local.set({ [STORAGE_KEY_HISTORIAL]: historial }); } catch (_) {}
      }, 1000);
    }

    await cargarStorage();

    //—— Botón de alarma ————————————————————————————————————————————————
    const botonAlarma = core.registrarBoton({
      id: "jambot-ataques-confirm",
      label: "🔔 Revisé ataques",
      onClick: () => silenciarAlarma(),
    });
    botonAlarma.el.style.display = "none";
    botonAlarma.setStyle({ bg: "#e74c3c", fg: "#fff" });

    //—— Alarma ——————————————————————————————————————————————————————————
    function dispararAlarma(nuevos) {
      if (alarmaActiva) {
        actualizarBoton();
        return;
      }
      alarmaActiva = true;

      const resumen = nuevos
        .map((a) => `${LABEL_TIPO[a.type] || a.type} ← ${a.originPlayerName || "?"}`)
        .join(" | ");
      core.logWarn(
        "ataquesEntrantes",
        `🚨 ${nuevos.length} ataque(s) entrante(s) NUEVO(S) — ${resumen}`
      );

      const ahora = Date.now();
      for (const a of nuevos) {
        historial.push({
          ts: ahora,
          id: a.id,
          type: a.type,
          originTownName: a.originTownName,
          originPlayerName: a.originPlayerName,
          destTownId: a.destTownId,
          destTownName: a.destTownName,
          arrivalAt: a.arrivalAt,
        });
      }
      while (historial.length > HISTORIAL_MAX) historial.shift();
      persistirHistorial();

      actualizarBoton();
      botonAlarma.el.style.display = "";

      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
      } catch (e) {
        core.logWarn("ataquesEntrantes", "AudioContext no disponible — alarma solo visual");
        audioCtx = null;
      }
      //Beep agudo cortado — 1100Hz square wave para que sea inconfundible
      //con el del oro (1400Hz). Quien escuche ambos en una sesión los
      //distingue por el pitch.
      const beep = () => {
        if (!audioCtx) return;
        try {
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.connect(g);
          g.connect(audioCtx.destination);
          o.type = "square";
          o.frequency.value = 1100;
          const t = audioCtx.currentTime;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.2, t + 0.02);
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
        document.title = on ? "🚨 ATAQUE — JamBot" : tituloOriginal;
      }, 800);
    }

    function actualizarBoton() {
      const noAck = ataquesActuales.filter((a) => !ackIds.has(a.id));
      const n = noAck.length;
      if (n === 0) {
        botonAlarma.setLabel("🔔 Revisé ataques");
        return;
      }
      //Mostramos cuál ataque llega primero. arrival_at viene en segundos
      //(timestamp del server), comparamos contra Date.now()/1000.
      let proximoSeg = Infinity;
      for (const a of noAck) {
        if (a.arrivalAt && a.arrivalAt < proximoSeg) proximoSeg = a.arrivalAt;
      }
      const ahoraSeg = Math.floor(Date.now() / 1000);
      const seg = Math.max(0, Math.round(proximoSeg - ahoraSeg));
      const lbl = seg === Infinity ? "" : ` · próximo en ${core.formatDuracion(seg)}`;
      botonAlarma.setLabel(`🚨 ${n} ataque(s)${lbl}`);
    }

    function silenciarAlarma() {
      if (!alarmaActiva) return;
      alarmaActiva = false;
      //Ack TODOS los actuales — si entra otro nuevo después, vuelve a sonar.
      let agregados = 0;
      for (const a of ataquesActuales) {
        if (!ackIds.has(a.id)) { ackIds.add(a.id); agregados += 1; }
      }
      if (agregados) persistirAck();
      core.log("ataquesEntrantes", `alarma silenciada — ${agregados} ataque(s) ack'd`, "ok");
      botonAlarma.el.style.display = "none";
      botonAlarma.setLabel("🔔 Revisé ataques");
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

    //—— Request ————————————————————————————————————————————————————————
    //
    //El endpoint `town_overviews:command_overview` devuelve la vista global
    //de órdenes — incluye comandos de TODAS mis ciudades en un solo request
    //(no hace falta uno por ciudad). El `town_id` que se pasa es el de la
    //sesión actual, no filtra el resultado por esa ciudad.
    async function obtenerComandos() {
      const json = JSON.stringify({ town_id: townId, nl_init: true });
      const url =
        `https://${world_id}.grepolis.com/game/town_overviews` +
        `?town_id=${townId}&action=command_overview&h=${csrfToken}` +
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

    //—— Ciclo ————————————————————————————————————————————————————————
    async function ciclo() {
      if (!core.isExtensionContextValid()) return;
      if (core.isCaptchaActive()) return;

      let data;
      try {
        data = await obtenerComandos();
        ultimoPollOk = true;
        ultimoPollError = null;
      } catch (e) {
        ultimoPollOk = false;
        ultimoPollError = e.message;
        core.logWarn("ataquesEntrantes", `poll falló: ${e.message}`);
        return;
      } finally {
        ultimoPollTs = Date.now();
      }

      const j = data && data.json;
      const d = j && j.data;
      if (!d) return;
      const myPlayerId = d.player_id != null ? d.player_id : player_id;
      const attackTypes = d.attack_types || {};
      const cmds = Array.isArray(d.commands) ? d.commands : [];

      const entrantes = [];
      for (const c of cmds) {
        if (!c || c.return) continue;
        const tipo = c.type;
        if (!tipo) continue;
        //Replicamos el filtro del template del cliente (Vista general de
        //órdenes): incoming si destino es mío Y el tipo es de ataque.
        if (Number(c.destination_town_player_id) !== Number(myPlayerId)) continue;
        if (!Object.prototype.hasOwnProperty.call(attackTypes, tipo)) continue;
        entrantes.push({
          id: c.id,
          type: tipo,
          cmdType: c.command_type,
          originTownId: c.origin_town_id,
          originTownName: c.origin_town_name || textoDeAnchor(c.townurl_base64_origin),
          originPlayerName: c.origin_town_player_name || textoDeAnchor(c.userurl_base64_origin),
          destTownId: c.destination_town_id,
          destTownName: c.destination_town_name || textoDeAnchor(c.townurl_base64_destination),
          arrivalAt: c.arrival_at,
          startedAt: c.started_at,
        });
      }
      ataquesActuales = entrantes;

      //Purgar acks "huérfanos" — ataques que ya no están (llegaron o
      //fueron cancelados). Sin esto ackIds crecería sin techo.
      const vivos = new Set(entrantes.map((a) => String(a.id)));
      let purgo = 0;
      for (const id of Array.from(ackIds)) {
        if (!vivos.has(String(id))) { ackIds.delete(id); purgo += 1; }
      }
      if (purgo) persistirAck();

      const nuevos = entrantes.filter((a) => !ackIds.has(a.id));
      if (nuevos.length > 0) {
        dispararAlarma(nuevos);
      } else if (alarmaActiva) {
        actualizarBoton();
      }
    }

    //—— Render del tab "Defensa" ————————————————————————————————————————
    //
    //Mismo estilo visual que mercadoOro / ataques (cards #172029 con border
    //#2c3a4d). Recoleccion lo invoca cada segundo mientras el tab está
    //visible — countdown a la llegada de cada ataque se refresca en vivo.

    function fmtCountdown(arrivalAt) {
      if (!arrivalAt) return "—";
      const seg = Math.round(arrivalAt - Date.now() / 1000);
      if (seg <= 0) return "ya llegó";
      return core.formatDuracion(seg);
    }

    function fmtHora(ms) {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function fmtTiempoRel(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return `hace ${s}s`;
      if (s < 3600) return `hace ${Math.floor(s / 60)}m ${s % 60}s`;
      return `hace ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }

    function renderHeader() {
      const wrap = document.createElement("div");
      const noAck = ataquesActuales.filter((a) => !ackIds.has(a.id));
      const totalAtaques = ataquesActuales.length;
      const corriendo = !core.isCaptchaActive();
      const borderColor =
        alarmaActiva ? "#e74c3c" :
        noAck.length > 0 ? "#f39c12" :
        corriendo ? "#27ae60" : "#7a8aa0";
      wrap.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 12px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${borderColor}`;
      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const titulo = document.createElement("div");
      titulo.textContent = "Monitor de ataques entrantes";
      titulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const sub = document.createElement("div");
      sub.textContent = alarmaActiva
        ? `🚨 ALARMA ACTIVA — ${noAck.length} ataque(s) sin revisar`
        : !corriendo
          ? "En espera — CAPTCHA activo"
          : totalAtaques === 0
            ? `Activo · revisa cada ${POLL_INTERVAL_MS / 1000}s · sin ataques entrantes`
            : `Activo · ${totalAtaques} ataque(s) entrante(s) — todo silenciado`;
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      left.appendChild(titulo);
      left.appendChild(sub);
      wrap.appendChild(left);
      return wrap;
    }

    function renderExplicacion() {
      const v = document.createElement("div");
      v.innerHTML =
        `Revisa la <b>Vista general de órdenes</b> del juego cada ` +
        `<b>${POLL_INTERVAL_MS / 1000}s</b> y dispara una alarma sostenida ` +
        `cuando aparece un ataque entrante <b>nuevo</b> dirigido a cualquiera ` +
        `de tus ciudades. La alarma <b>no para</b> hasta que apretes ` +
        `<b>🔔 Revisé ataques</b>. Si después entra otro ataque distinto, ` +
        `vuelve a sonar.`;
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

    function renderTablaEntrantes() {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;overflow:hidden";
      if (!ataquesActuales.length) {
        const v = document.createElement("div");
        v.textContent =
          ultimoPollTs === 0
            ? "Esperando primer poll…"
            : ultimoPollOk
              ? "Sin ataques entrantes."
              : `Último poll falló: ${ultimoPollError || "?"}`;
        v.style.cssText = "padding:10px 12px;color:#7a8aa0;font-style:italic;font-size:11.5px";
        wrap.appendChild(v);
        return wrap;
      }
      const head = `
        <tr style="background:#1a232e;color:#7a8aa0;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px">
          <th style="padding:6px 10px;text-align:left">Tipo</th>
          <th style="padding:6px 10px;text-align:left">Origen</th>
          <th style="padding:6px 10px;text-align:left">Destino</th>
          <th style="padding:6px 10px;text-align:right">Llega en</th>
          <th style="padding:6px 10px;text-align:center">Estado</th>
        </tr>
      `;
      const ordenados = ataquesActuales.slice().sort((a, b) => (a.arrivalAt || 0) - (b.arrivalAt || 0));
      let rows = "";
      for (const a of ordenados) {
        const ack = ackIds.has(a.id);
        const critico = TIPO_CRITICO.has(a.type);
        const tipoColor = critico ? "#e74c3c" : "#f39c12";
        const estadoTxt = ack ? "✓ revisado" : "🚨 nuevo";
        const estadoColor = ack ? "#27ae60" : "#e74c3c";
        const origen =
          `<span style="color:#e6e9ee">${escapeHtml(a.originPlayerName || "?")}</span>` +
          (a.originTownName ? ` <span style="color:#7a8aa0">· ${escapeHtml(a.originTownName)}</span>` : "");
        const destino = a.destTownName
          ? `<span style="color:#e6e9ee">${escapeHtml(a.destTownName)}</span>`
          : `<span style="color:#7a8aa0;font-family:monospace">#${a.destTownId || "?"}</span>`;
        rows += `
          <tr style="border-top:1px solid #2c3a4d;font-size:12px">
            <td style="padding:8px 10px;color:${tipoColor};font-weight:bold">${escapeHtml(LABEL_TIPO[a.type] || a.type)}</td>
            <td style="padding:8px 10px">${origen}</td>
            <td style="padding:8px 10px">${destino}</td>
            <td style="padding:8px 10px;text-align:right;color:#e6e9ee;font-family:monospace">${fmtCountdown(a.arrivalAt)}</td>
            <td style="padding:8px 10px;text-align:center;color:${estadoColor};font-weight:bold">${estadoTxt}</td>
          </tr>
        `;
      }
      wrap.innerHTML = `<table style="width:100%;border-collapse:collapse">${head}${rows}</table>`;
      return wrap;
    }

    function renderHistorial() {
      const wrap = document.createElement("div");
      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;margin:14px 0 8px";
      const subt = document.createElement("div");
      subt.textContent = "HISTORIAL DE ALARMAS";
      subt.style.cssText =
        "flex:1;font-size:10.5px;font-weight:bold;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      head.appendChild(subt);
      if (historial.length) {
        const clr = document.createElement("button");
        clr.textContent = "limpiar";
        clr.style.cssText =
          "margin-left:8px;background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 10px;" +
          "cursor:pointer;border-radius:3px;font-size:11px;font-weight:bold";
        clr.addEventListener("click", () => {
          if (!confirm("¿Borrar el historial de alarmas de ataques?")) return;
          historial = [];
          persistirHistorial();
          const body = document.querySelector("#panelConfigJam .pcj-body");
          if (body) renderTab(body);
        });
        head.appendChild(clr);
      }
      wrap.appendChild(head);
      if (!historial.length) {
        const v = document.createElement("div");
        v.textContent = "Sin alarmas registradas.";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11.5px;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const lista = document.createElement("div");
      lista.id = "ataquesEntrantesHistorialLista";
      lista.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        "max-height:240px;overflow-y:auto";
      let html = "";
      for (const h of historial.slice().reverse()) {
        const tipo = escapeHtml(LABEL_TIPO[h.type] || h.type);
        const origen = escapeHtml(h.originPlayerName || "?");
        const destino = escapeHtml(h.destTownName || `#${h.destTownId || "?"}`);
        const critico = TIPO_CRITICO.has(h.type);
        const tipoColor = critico ? "#e74c3c" : "#f39c12";
        html += `
          <div style="padding:6px 10px;border-top:1px solid #2c3a4d;font-size:12px">
            <span style="color:#7a8aa0;font-family:monospace;font-size:11px">${fmtHora(h.ts)}</span>
            <b style="margin:0 8px;color:${tipoColor}">${tipo}</b>
            <span style="color:#e6e9ee">${origen}</span>
            <span style="color:#7a8aa0"> → ${destino}</span>
            <span style="color:#5a6776;float:right">${fmtTiempoRel(h.ts)}</span>
          </div>
        `;
      }
      lista.innerHTML = html;
      wrap.appendChild(lista);
      return wrap;
    }

    function renderTab(body) {
      //Preservar scroll del historial (renderTab se llama cada segundo).
      const listaPrev = body.querySelector("#ataquesEntrantesHistorialLista");
      const scrollPrev = listaPrev ? listaPrev.scrollTop : 0;

      body.innerHTML = "";
      body.appendChild(renderHeader());
      body.appendChild(renderExplicacion());

      body.appendChild(renderSubtitulo("Ataques entrantes ahora"));
      body.appendChild(renderTablaEntrantes());

      body.appendChild(renderHistorial());

      if (scrollPrev) {
        const listaNew = body.querySelector("#ataquesEntrantesHistorialLista");
        if (listaNew) listaNew.scrollTop = scrollPrev;
      }
    }

    //—— Arranque ———————————————————————————————————————————————————————
    setInterval(() => {
      ciclo().catch((e) => core.logError("ataquesEntrantes", "ciclo falló", e));
    }, POLL_INTERVAL_MS);
    ciclo().catch((e) => core.logError("ataquesEntrantes", "ciclo inicial falló", e));

    core.log(
      "ataquesEntrantes",
      `iniciado (poll cada ${POLL_INTERVAL_MS / 1000}s, alarma persistente)`,
      "ok"
    );

    JamBot.features.ataquesEntrantes.api = { renderTab };
  }

  JamBot.features.ataquesEntrantes = { init };
})();
