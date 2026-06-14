/* features/comercio.js — envío automático de recursos entre ciudades propias.
 *
 * Concepto: el usuario crea "grupos". Cada grupo tiene un destino (1 ciudad
 * propia) + N fuentes (otras ciudades propias) + pesos por recurso + reserva
 * por recurso + intervalo (10–300s). Cada grupo tiene su propio scheduler:
 * cada `intervalSeg` segundos, refresca el estado del destino y manda lo que
 * pueda desde cada fuente, repartiendo la capacidad del mercado del origen
 * entre wood/stone/iron según los pesos configurados.
 *
 * Endpoint capturado:
 *   POST /game/town_info?town_id=<ORIGEN>&action=trade&h=<csrf>
 *   body (form): json={"id":<DESTINO>,"wood":N,"stone":N,"iron":N,
 *                       "town_id":<ORIGEN>,"nl_init":true}
 *
 * El response trae notification "Town" del origen (con resources,
 * `max_trade_capacity`, `available_trade_capacity`, `storage`) y notification
 * "Trade" del nuevo envío (id, recursos, started_at, arrival_at). El bridge
 * las inyecta a MM y la UI del juego se actualiza sola.
 *
 * Validación clave: ANTES de cada ciclo del grupo hago 1 refetch de la
 * collection Towns para tener resources/storage frescos del destino. Si el
 * espacio en destino para los 3 recursos da 0 (almacén lleno), salteo el
 * envío de todas las fuentes — no se desperdician recursos.
 *
 * Independiente de recolección y del play/pause global: tiene su propio
 * master switch (`data.comercio.habilitada`). Respeta CAPTCHA y
 * isExtensionContextValid.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  const RECURSOS = ["wood", "stone", "iron"];
  const LABEL_RECURSO = { wood: "Madera", stone: "Piedra", iron: "Hierro" };
  const COLOR_RECURSO = { wood: "#c39a55", stone: "#bdc3c7", iron: "#95a5a6" };
  //Default 1/1/1 = reparto equitativo. Range 0-100 (slider).
  const PESO_DEFAULT = 1;
  const PESO_MAX = 100;
  //Interval: 10s mínimo (no spamear), 5min máximo. Default 15s.
  const INTERVAL_MIN_SEG = 10;
  const INTERVAL_MAX_SEG = 300;
  const INTERVAL_DEFAULT_SEG = 15;
  const HISTORIAL_MAX = 100;
  //Cache de trades en vuelo: refresh max cada 5s, evita spamear el bridge
  //cuando renderTab corre cada 1s.
  const TRADES_CACHE_TTL_MS = 5000;
  //Jitter del scheduler: ±15% del intervalo para romper patrón exacto.
  const JITTER_FRAC = 0.15;

  //—— Modos de cálculo del payload ————————————————————————————————————
  //
  //  "objetivo"     — el usuario fija "cuánto quiero tener en el destino"
  //                   por recurso (default = cap del almacén). El bot calcula
  //                   faltante = objetivo - recursos_destino - trades_en_vuelo
  //                   y reparte la capacidad del mercado del origen entre los
  //                   recursos PROPORCIONAL al faltante. No usa pesos.
  //  "proporcional" — modo legacy: pesos por recurso (0-100) deciden cómo
  //                   se reparte la capacidad del mercado del origen.
  //                   Mantenido para backwards-compat de grupos existentes.
  //
  //Decisión: grupos NUEVOS arrancan en "objetivo" porque es el caso de uso
  //común (mantener una ciudad llena para que recolección no se desperdicie).
  //Grupos viejos cargados del storage mantienen su modo si ya lo tenían;
  //si no tienen el campo (versión previa), `normalizarGrupo` les pone
  //"proporcional" para preservar exactamente su comportamiento anterior.
  const MODO_DEFAULT_NUEVO = "objetivo";
  const MODOS_VALIDOS = ["objetivo", "proporcional"];

  //Saturación del ORIGEN: una fuente cuenta como "saturada" si al menos
  //SATURACION_MIN_RECURSOS de los 3 recursos están al ≥ SATURACION_PCT del
  //cap del almacén del origen. Las saturadas se priorizan en modo objetivo
  //porque mandando lo que ya iba a perderse (cap top-toca → recolección se
  //desperdicia en esa ciudad), liberamos espacio que la recolección va a
  //rellenar gratis. Umbrales: 95% (no 100%) captura "casi-llena" donde ya
  //hay desperdicio; 2 de 3 (no 3 de 3) porque madera siempre satura
  //primero — esperar a las 3 al tope hace que la heurística nunca dispare.
  const SATURACION_PCT = 0.95;
  const SATURACION_MIN_RECURSOS = 2;

  //Mercado nivel mínimo para enviar a OTRA isla. Por debajo, el server
  //rechaza el envío con error y se gasta el intento. Lo pre-filtramos en
  //cliente cuando podemos detectar el nivel (gameBridge lee el modelo Town).
  //Si el nivel viene null (modelo no expuesto en esta versión del juego),
  //no pre-filtramos — el server hará el gating y veremos el error en el log.
  //Envíos a la misma isla NO requieren este nivel (mercado nivel ≥1 alcanza).
  const MARKET_LEVEL_INTER_ISLA = 5;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function jitterMs(baseMs) {
    const frac = (Math.random() * 2 - 1) * JITTER_FRAC;
    return Math.max(100, Math.floor(baseMs * (1 + frac)));
  }

  function uuid() {
    return "g-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  /**
   * Reparte `capacidad` (capacidad libre del mercado origen) entre los 3
   * recursos según los `pesos` configurados, respetando:
   *   - `topePorRecurso[r] = max(0, min(stock - reserva, espacioDestino))`
   *   - peso 0 ⇒ nunca mandar ese recurso (ni siquiera para rellenar)
   *
   * Si un recurso tope-toca antes de llegar a su objetivo proporcional, la
   * capacidad sobrante se redistribuye entre los demás candidatos en otra
   * vuelta. Si todos tope-tocaron y aún sobra capacidad, queda capacidad sin
   * usar (no hay donde meterla). Si suma de pesos = 0, no manda nada.
   *
   * Devuelve {wood, stone, iron} enteros. La suma es ≤ capacidad y cada
   * componente ≤ topePorRecurso[r]. Función pura.
   */
  function calcularPayload(capacidad, pesos, topePorRecurso) {
    const enviar = { wood: 0, stone: 0, iron: 0 };
    if (!Number.isFinite(capacidad) || capacidad <= 0) return enviar;
    let capRestante = Math.floor(capacidad);
    const candidatos = new Set(
      RECURSOS.filter((r) => (pesos[r] || 0) > 0 && (topePorRecurso[r] || 0) > 0)
    );
    //Bucle: distribuir proporcionalmente, sacar los que tope-toquen y
    //repetir con los que sobran. Cap de 6 iteraciones por seguridad (en la
    //práctica converge en ≤ 3 con 3 recursos).
    for (let iter = 0; iter < 6 && capRestante > 0 && candidatos.size > 0; iter++) {
      const sumaPesos = [...candidatos].reduce((s, r) => s + pesos[r], 0);
      if (sumaPesos <= 0) break;
      let asignadoEstaRonda = 0;
      let algunoCambio = false;
      for (const r of [...candidatos]) {
        const objetivo = Math.floor(capRestante * pesos[r] / sumaPesos);
        const margen = topePorRecurso[r] - enviar[r];
        const agrega = Math.min(objetivo, margen);
        if (agrega > 0) {
          enviar[r] += agrega;
          asignadoEstaRonda += agrega;
          algunoCambio = true;
        }
        if (enviar[r] >= topePorRecurso[r]) candidatos.delete(r);
      }
      capRestante -= asignadoEstaRonda;
      if (!algunoCambio) break;
    }
    //Pulido: si todavía queda capacidad y candidatos con margen, llenarlos
    //en orden de peso descendente. Esto pasa por redondeo (Math.floor del
    //objetivo proporcional pierde algo en cada iteración).
    if (capRestante > 0 && candidatos.size > 0) {
      const ord = [...candidatos].sort((a, b) => (pesos[b] || 0) - (pesos[a] || 0));
      for (const r of ord) {
        if (capRestante <= 0) break;
        const margen = topePorRecurso[r] - enviar[r];
        const agrega = Math.min(margen, capRestante);
        enviar[r] += agrega;
        capRestante -= agrega;
      }
    }
    return enviar;
  }

  /**
   * Reparte `capacidad` (capacidad libre del mercado origen) entre los 3
   * recursos PROPORCIONAL al faltante de cada recurso en el destino. Usado
   * por modo "objetivo".
   *
   *   topePorRecurso[r] = max(0, min(stock_origen[r] - reserva_origen[r],
   *                                  objetivo_dest[r] - resources_dest[r] - incoming[r]))
   *
   * Decisión: reparto proporcional al faltante (no por orden fijo ni
   * equitativo). Razón: si destino necesita 10k madera y 5k piedra y la
   * capacidad del origen es 6k, queremos mandar 4k madera + 2k piedra
   * (proporcional 10:5). Esto evita quedar "casi llena" en el recurso que
   * más falta mientras los otros ya están al objetivo.
   *
   * Función pura. Devuelve {wood, stone, iron} enteros con suma ≤ capacidad.
   */
  function calcularPayloadObjetivo(capacidad, topePorRecurso) {
    const enviar = { wood: 0, stone: 0, iron: 0 };
    if (!Number.isFinite(capacidad) || capacidad <= 0) return enviar;
    let capRestante = Math.floor(capacidad);
    const candidatos = RECURSOS.filter((r) => (topePorRecurso[r] || 0) > 0);
    if (!candidatos.length) return enviar;
    //Bucle: reparte proporcional al faltante restante, saca los que
    //tope-toquen y repite. Cap 6 iters por seguridad (converge en ≤ 3).
    for (let iter = 0; iter < 6 && capRestante > 0; iter++) {
      const faltantes = {};
      let sumaFaltante = 0;
      for (const r of candidatos) {
        const m = (topePorRecurso[r] || 0) - enviar[r];
        faltantes[r] = m > 0 ? m : 0;
        sumaFaltante += faltantes[r];
      }
      if (sumaFaltante <= 0) break;
      let asignado = 0;
      for (const r of candidatos) {
        if (faltantes[r] <= 0) continue;
        const obj = Math.floor(capRestante * faltantes[r] / sumaFaltante);
        const agrega = Math.min(obj, faltantes[r]);
        if (agrega > 0) {
          enviar[r] += agrega;
          asignado += agrega;
        }
      }
      capRestante -= asignado;
      if (asignado === 0) break;
    }
    //Pulido por redondeo: si sobra capacidad y queda alguien con margen,
    //llenar en orden de mayor faltante restante.
    if (capRestante > 0) {
      const ord = candidatos.slice().sort((a, b) =>
        ((topePorRecurso[b] || 0) - enviar[b]) -
        ((topePorRecurso[a] || 0) - enviar[a])
      );
      for (const r of ord) {
        if (capRestante <= 0) break;
        const margen = (topePorRecurso[r] || 0) - enviar[r];
        if (margen <= 0) continue;
        const agrega = Math.min(margen, capRestante);
        enviar[r] += agrega;
        capRestante -= agrega;
      }
    }
    return enviar;
  }

  /**
   * Suma los recursos de todos los trades con destino `destinoId`. Devuelve
   * `{wood, stone, iron}` enteros.
   *
   * Usado para descontar del espacio libre del destino los recursos que ya
   * están en vuelo hacia él — sin esto, varios ciclos seguidos disparan
   * envíos que al llegar todos juntos topan el almacén y se pierde el
   * excedente. Ejemplo: cap=30k, recurso=13k, 5k en vuelo → el bot
   * "ve" 17k libres y manda otros 17k; al llegar todos sobran 5k.
   *
   * Función pura.
   */
  function sumarIncomingPorDestino(trades, destinoId) {
    const acc = { wood: 0, stone: 0, iron: 0 };
    if (!Array.isArray(trades) || destinoId == null) return acc;
    const did = String(destinoId);
    for (const t of trades) {
      if (!t || String(t.destinationTownId) !== did) continue;
      acc.wood  += Number(t.wood)  || 0;
      acc.stone += Number(t.stone) || 0;
      acc.iron  += Number(t.iron)  || 0;
    }
    return acc;
  }

  /**
   * True si el origen está "saturado": al menos SATURACION_MIN_RECURSOS de
   * los 3 recursos están al ≥ SATURACION_PCT del cap del almacén. Si no
   * tenemos cap o resources, devuelve false (no hay info → no priorizamos).
   */
  function esOrigenSaturado(townInfo) {
    if (!townInfo || !townInfo.resources || !townInfo.storage) return false;
    const cap = townInfo.storage;
    if (cap <= 0) return false;
    const umbral = cap * SATURACION_PCT;
    let n = 0;
    for (const r of RECURSOS) {
      if ((townInfo.resources[r] || 0) >= umbral) n++;
    }
    return n >= SATURACION_MIN_RECURSOS;
  }

  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id, townId, player_id } = game;

    const STORAGE_KEY = `jambotComercio_${world_id}`;

    //—— Estado expuesto ————————————————————————————————————————————————
    //
    //   habilitada:        master switch (toggle propio, no del bot global).
    //   grupos:            [{ id, nombre, destinoTownId, fuentes:[{townId}],
    //                         pesos:{wood,stone,iron}, reserva:{wood,stone,iron},
    //                         intervalSeg, enabled }]
    //   ultimoPorGrupoFuente: {[grupoId]: {[fuenteId]: {ts, sent, viajeMs?, error?}}}
    //   ultimoCicloPorGrupo:  {[grupoId]: {ts, motivo?, destinoLleno?, fuentes:[...]}}
    //   historial:         FIFO últimos HISTORIAL_MAX envíos OK.
    //   uiState:           runtime — no persiste — qué grupos están expandidos.
    //   tradesCache:       cache de queryTrades.
    data.comercio = data.comercio || {
      habilitada: false,
      grupos: [],
      ultimoPorGrupoFuente: {},
      ultimoCicloPorGrupo: {},
      historial: [],
      uiState: { expandidos: {}, mostrarHistorial: false },
      tradesCache: { ts: 0, trades: [] },
    };

    //—— Persistencia ————————————————————————————————————————————————————
    await new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (obj) => {
          const blob = (obj && obj[STORAGE_KEY]) || {};
          if (typeof blob.habilitada === "boolean") data.comercio.habilitada = blob.habilitada;
          if (Array.isArray(blob.grupos)) data.comercio.grupos = blob.grupos;
          if (blob.ultimoPorGrupoFuente && typeof blob.ultimoPorGrupoFuente === "object") {
            data.comercio.ultimoPorGrupoFuente = blob.ultimoPorGrupoFuente;
          }
          if (Array.isArray(blob.historial)) data.comercio.historial = blob.historial;
          //Normalización defensiva de cada grupo (por si el shape cambió o
          //alguien editó storage a mano).
          for (const g of data.comercio.grupos) {
            normalizarGrupo(g);
          }
          resolve();
        });
      } catch (_) { resolve(); }
    });

    function normalizarGrupo(g) {
      if (!g.id) g.id = uuid();
      if (typeof g.nombre !== "string") g.nombre = "Grupo";
      if (!Array.isArray(g.fuentes)) g.fuentes = [];
      g.fuentes = g.fuentes.filter((f) => f && f.townId);
      if (!g.pesos || typeof g.pesos !== "object") g.pesos = {};
      if (!g.reserva || typeof g.reserva !== "object") g.reserva = {};
      //objetivo: por recurso, valor absoluto del "cuánto quiero tener en
      //destino". null = "hasta el cap del almacén del destino" (dinámico,
      //sigue al cap si el usuario sube el almacén in-game). 0 = "no mandar
      //este recurso a este destino". Cualquier número > 0 = "llenar hasta
      //ese valor". Solo aplica si modo === "objetivo".
      if (!g.objetivo || typeof g.objetivo !== "object") g.objetivo = {};
      for (const r of RECURSOS) {
        const p = Number(g.pesos[r]);
        g.pesos[r] = Number.isFinite(p) && p >= 0 ? Math.min(p, PESO_MAX) : PESO_DEFAULT;
        const rs = Number(g.reserva[r]);
        g.reserva[r] = Number.isFinite(rs) && rs >= 0 ? Math.floor(rs) : 0;
        //objetivo[r]: null si no está seteado o si vino "" del input vacío.
        //Number si está seteado a un valor explícito.
        const obj = g.objetivo[r];
        if (obj == null || obj === "" || !Number.isFinite(Number(obj))) {
          g.objetivo[r] = null;
        } else {
          g.objetivo[r] = Math.max(0, Math.floor(Number(obj)));
        }
      }
      const intv = Number(g.intervalSeg);
      g.intervalSeg = Number.isFinite(intv)
        ? Math.min(Math.max(intv, INTERVAL_MIN_SEG), INTERVAL_MAX_SEG)
        : INTERVAL_DEFAULT_SEG;
      if (typeof g.enabled !== "boolean") g.enabled = true;
      //modo: si no viene del storage, asumir "proporcional" (preserva
      //comportamiento de grupos pre-objetivo). Grupos nuevos se crean
      //explícitamente con MODO_DEFAULT_NUEVO desde el botón "Nuevo grupo".
      if (!MODOS_VALIDOS.includes(g.modo)) g.modo = "proporcional";
      //viajeMsPorFuente: cache de tiempo de viaje origen→destino, poblado
      //tras cada envío exitoso (gratis, lo da la response Trade). Lo usa
      //el orden de fuentes del ciclo "objetivo" como proxy de distancia.
      //Si una fuente nunca envió a este destino, queda al final del orden
      //(viajeMs = Infinity) y se desempata por orden de config.
      if (!g.viajeMsPorFuente || typeof g.viajeMsPorFuente !== "object") {
        g.viajeMsPorFuente = {};
      }
    }

    let saveTimer = null;
    function persistir() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        if (!core.isExtensionContextValid()) return;
        try {
          chrome.storage.local.set({
            [STORAGE_KEY]: {
              habilitada: data.comercio.habilitada,
              grupos: data.comercio.grupos,
              ultimoPorGrupoFuente: data.comercio.ultimoPorGrupoFuente,
              historial: data.comercio.historial,
            },
          });
        } catch (_) { /* extensión recargada */ }
      }, 400);
    }

    //—— Bridge helpers ——————————————————————————————————————————————————
    //
    //queryTown: pide al bridge los resources / storage / market caps de un
    //Town cargado en MM. Si el modelo no está cargado, devuelve campos null.
    function queryTown(targetTownId) {
      return new Promise((resolve) => {
        let resuelto = false;
        function onMsg(e) {
          if (e.source !== window) return;
          const m = e.data;
          if (!m || m.type !== "JamBot:townResources") return;
          if (String(m.townId) !== String(targetTownId)) return;
          if (resuelto) return;
          resuelto = true;
          window.removeEventListener("message", onMsg);
          resolve(m);
        }
        window.addEventListener("message", onMsg);
        window.dispatchEvent(new CustomEvent("JamBot:queryTownResources", {
          detail: { townId: targetTownId },
        }));
        setTimeout(() => {
          if (resuelto) return;
          resuelto = true;
          window.removeEventListener("message", onMsg);
          resolve(null);
        }, 1500);
      });
    }

    function queryTrades() {
      return new Promise((resolve) => {
        let resuelto = false;
        function onMsg(e) {
          if (e.source !== window) return;
          const m = e.data;
          if (!m || m.type !== "JamBot:tradesResult") return;
          if (resuelto) return;
          resuelto = true;
          window.removeEventListener("message", onMsg);
          resolve((m.trades) || []);
        }
        window.addEventListener("message", onMsg);
        window.dispatchEvent(new CustomEvent("JamBot:queryTrades", {
          detail: { playerId: player_id },
        }));
        setTimeout(() => {
          if (resuelto) return;
          resuelto = true;
          window.removeEventListener("message", onMsg);
          resolve([]);
        }, 1500);
      });
    }

    function dispatchNotifs(body) {
      const notifs = body && body.json && body.json.notifications;
      if (Array.isArray(notifs) && notifs.length) {
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: notifs },
        }));
      }
    }

    //—— Refetch del destino antes del ciclo ——————————————————————————————
    //
    //Para validar el espacio del destino (storage cap - resources) necesito
    //datos frescos. Hago refetch de la collection Towns (1 GET) y MM se
    //actualiza vía notifications. Si fallara, devolvemos null y el ciclo
    //usará lo que tenga MM (puede estar stale).
    async function refetchTowns() {
      if (!core.isExtensionContextValid()) return false;
      const json = `{"collections":{"Towns":[]},"town_id":${townId},"nl_init":false}`;
      const url =
        `https://${world_id}.grepolis.com/game/frontend_bridge` +
        `?town_id=${townId}&action=refetch&h=${csrfToken}` +
        `&json=${encodeURIComponent(json)}&_=${Date.now()}`;
      try {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "text/plain, */*; q=0.01",
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        dispatchNotifs(body);
        return true;
      } catch (e) {
        core.logWarn("comercio", `refetch Towns falló: ${e.message}`);
        return false;
      }
    }

    //—— Envío al server ——————————————————————————————————————————————
    //
    //Replica el click "Enviar recursos" del cliente. Body capturado:
    //   {"id":<DESTINO>,"wood":N,"stone":N,"iron":N,
    //    "town_id":<ORIGEN>,"nl_init":true}
    //url-form encoded como `json=<JSON>`.
    async function enviarComercio(origenId, destinoId, counts) {
      const json = {
        id: destinoId,
        wood: counts.wood | 0,
        stone: counts.stone | 0,
        iron: counts.iron | 0,
        town_id: origenId,
        nl_init: true,
      };
      const datos = new URLSearchParams();
      datos.append("json", JSON.stringify(json));
      const url =
        `https://${world_id}.grepolis.com/game/town_info` +
        `?town_id=${origenId}&action=trade&h=${csrfToken}`;
      let response;
      try {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "text/plain, */*; q=0.01",
            //URLSearchParams default Content-Type es application/x-www-form-urlencoded;
            //no hace falta setearlo explícito.
          },
          body: datos,
        });
        response = await res.json();
      } catch (e) {
        return { ok: false, error: `fetch falló: ${e.message}` };
      }
      const j = response && response.json;
      if (!j) return { ok: false, error: "response sin .json" };
      if (!j.success) {
        return { ok: false, error: String(j.error || "sin success") };
      }
      dispatchNotifs(response);

      //Heurística de CAPTCHA: si no vino notification Trade ni Town, el
      //server probablemente pidió challenge. Mismo patrón que recolección/
      //ataques. Tener `success` string sin notifications también es señal.
      const notifs = Array.isArray(j.notifications) ? j.notifications : [];
      const tieneTrade = notifs.some((n) => n.subject === "Trade");
      const tieneTown = notifs.some((n) => n.subject === "Town");
      if (!tieneTrade && !tieneTown) {
        return { ok: false, error: "sin notifs Trade/Town (probable CAPTCHA)", probableCaptcha: true };
      }

      //Extraer timings del Trade para reagendar — informativo, no bloqueante.
      let viajeMs = null;
      for (const n of notifs) {
        if (n.subject !== "Trade") continue;
        try {
          const p = JSON.parse(n.param_str);
          const t = p && p.Trade;
          if (!t) continue;
          if (t.started_at && t.arrival_at) {
            viajeMs = (Number(t.arrival_at) - Number(t.started_at)) * 1000;
          }
          break;
        } catch (_) { /* sigue */ }
      }
      return { ok: true, viajeMs };
    }

    //—— Scheduler por grupo ————————————————————————————————————————————
    //
    //Cada grupo tiene su propio setTimeout. timersPorGrupo[grupoId] guarda
    //el handle pendiente; cancelarTimers() los limpia a todos.
    const timersPorGrupo = {};
    //Flag de "ciclo del grupo está corriendo ahora mismo" — evita que un
    //tick programado se solape con otro si el envío anterior tardó más que
    //el intervalo (puede pasar con red lenta + muchas fuentes).
    const ejecutandoCiclo = {};

    function cancelarTimers() {
      for (const id of Object.keys(timersPorGrupo)) {
        clearTimeout(timersPorGrupo[id]);
        delete timersPorGrupo[id];
      }
    }

    function reagendarGrupo(grupo, ms) {
      if (timersPorGrupo[grupo.id]) clearTimeout(timersPorGrupo[grupo.id]);
      timersPorGrupo[grupo.id] = setTimeout(() => {
        delete timersPorGrupo[grupo.id];
        ciclo(grupo.id).catch((e) => core.logError("comercio", `ciclo ${grupo.id} falló`, e));
      }, ms);
    }

    function buscarGrupo(grupoId) {
      return data.comercio.grupos.find((g) => g.id === grupoId);
    }

    function nombreCiudad(tid) {
      const c = (data.ciudadesConAldeas || []).find((x) => x.codigoCiudad === tid);
      return c ? c.nombreCiudad : `#${tid}`;
    }

    async function ciclo(grupoId) {
      if (!core.isExtensionContextValid()) return;
      const grupo = buscarGrupo(grupoId);
      if (!grupo) return;
      if (!data.comercio.habilitada) return;
      if (!grupo.enabled) return;
      if (core.isCaptchaActive()) {
        //CAPTCHA pasivo: reagendamos a 30s, el listener onCaptcha se encarga
        //de reanudar cuando se resuelva. Esto es belt-and-suspenders.
        reagendarGrupo(grupo, 30000);
        return;
      }
      if (!grupo.destinoTownId) {
        reagendarGrupo(grupo, grupo.intervalSeg * 1000);
        return;
      }
      if (!grupo.fuentes.length) {
        reagendarGrupo(grupo, grupo.intervalSeg * 1000);
        return;
      }
      if (ejecutandoCiclo[grupoId]) return;
      ejecutandoCiclo[grupoId] = true;

      const ahora = Date.now();
      const resumen = { ts: ahora, modo: grupo.modo, fuentes: [] };
      const esModoObjetivo = grupo.modo === "objetivo";

      try {
        //Refetch del destino para tener resources/storage frescos.
        await refetchTowns();
        const destinoInfo = await queryTown(grupo.destinoTownId);
        if (!destinoInfo || !destinoInfo.resources || destinoInfo.storage == null) {
          resumen.motivo = "destino sin datos en MM tras refetch";
          data.comercio.ultimoCicloPorGrupo[grupo.id] = resumen;
          return;
        }
        const storage = destinoInfo.storage;

        //Trades en vuelo hacia el destino: hay que descontarlos del espacio
        //libre, sino ciclos consecutivos disparan envíos que al llegar
        //topan el almacén y se pierde el excedente. Ejemplo: cap=30k,
        //recursos=13k, en vuelo=5k → "ve" 17k libres → manda 17k →
        //llegan 22k → sobran 5k. Con incoming descontado, espacio="12k".
        //
        //Aplica a AMBOS modos (proporcional y objetivo). En proporcional
        //era un bug de siempre que no se descontaba; ahora se corrige.
        const trades = await queryTrades();
        const incoming = sumarIncomingPorDestino(trades, grupo.destinoTownId);
        resumen.incoming = incoming;

        //Calcular "objetivo por recurso" según modo:
        //  - objetivo:     usa grupo.objetivo[r] || storage (cap). null = "hasta cap".
        //  - proporcional: usa storage (cap) — equivalente a "llenar hasta cap" pero
        //                  el peso 0 hace que no se mande nada de ese recurso.
        const objetivoPorRecurso = {};
        for (const r of RECURSOS) {
          if (esModoObjetivo) {
            const o = grupo.objetivo[r];
            objetivoPorRecurso[r] = o == null ? storage : o;
          } else {
            objetivoPorRecurso[r] = storage;
          }
        }
        //Espacio destino: cuánto puedo mandar por recurso sin pasarme del
        //objetivo. Considera lo que ya hay + lo que está por llegar.
        const espacioDestino = {};
        for (const r of RECURSOS) {
          espacioDestino[r] = Math.max(0,
            objetivoPorRecurso[r] - (destinoInfo.resources[r] || 0) - incoming[r]
          );
        }
        //Lleno relevante: recursos "activos" en este modo.
        //  - objetivo: relevante si objetivo[r] > 0 (sea null=cap o explícito > 0).
        //  - proporcional: relevante si pesos[r] > 0.
        let espacioRelevante = 0;
        for (const r of RECURSOS) {
          const activo = esModoObjetivo
            ? objetivoPorRecurso[r] > 0
            : (grupo.pesos[r] || 0) > 0;
          if (activo) espacioRelevante += espacioDestino[r];
        }
        if (espacioRelevante === 0) {
          resumen.destinoLleno = true;
          resumen.motivo = esModoObjetivo
            ? "destino ya en objetivo (contando trades en vuelo) — ciclo omitido"
            : "destino sin espacio en los recursos habilitados — ciclo omitido";
          data.comercio.ultimoCicloPorGrupo[grupo.id] = resumen;
          return;
        }

        //Pre-query de info de cada fuente: necesario para ordenarlas por
        //saturación (modo objetivo) y para calcular el payload. Lo hacemos
        //paralelo — es lectura barata del cache MM via bridge.
        const fuentesFiltradas = grupo.fuentes.filter((f) =>
          f.townId !== grupo.destinoTownId //no enviarse a sí mismo
        );
        const infos = await Promise.all(
          fuentesFiltradas.map((f) => queryTown(f.townId))
        );
        const fuentesConInfo = fuentesFiltradas.map((f, i) => ({
          fuente: f,
          info: infos[i],
          idxConfig: i,
        }));

        //Orden de fuentes:
        //  - objetivo:     saturadas primero (libera espacio que la
        //                  recolección va a re-llenar gratis), después por
        //                  viajeMs ASC (más cercanas primero, menos tiempo
        //                  con comerciantes ocupados en ruta), tiebreaker
        //                  orden de config.
        //  - proporcional: respeta orden de config (no se ordena —
        //                  preserva comportamiento histórico).
        if (esModoObjetivo) {
          fuentesConInfo.sort((a, b) => {
            const satA = esOrigenSaturado(a.info) ? 1 : 0;
            const satB = esOrigenSaturado(b.info) ? 1 : 0;
            if (satA !== satB) return satB - satA; //saturadas primero
            const vmA = grupo.viajeMsPorFuente[a.fuente.townId];
            const vmB = grupo.viajeMsPorFuente[b.fuente.townId];
            const vA = Number.isFinite(vmA) ? vmA : Infinity;
            const vB = Number.isFinite(vmB) ? vmB : Infinity;
            if (vA !== vB) return vA - vB; //más cercanas primero
            return a.idxConfig - b.idxConfig; //tiebreaker estable
          });
        }

        //Loop fuentes. El espacio del destino se decrementa localmente con
        //cada envío exitoso para que la fuente siguiente no se pase
        //(evita refetchear el destino tras cada envío).
        for (const { fuente, info: origenInfo } of fuentesConInfo) {
          if (!core.isExtensionContextValid()) break;
          if (core.isCaptchaActive()) break;
          if (!data.comercio.habilitada) break;
          //Early-exit si ya cubrimos el objetivo en los 3 recursos
          //(solo modo objetivo — el proporcional manda mientras haya
          //capacidad porque distribuye su excedente).
          if (esModoObjetivo) {
            const totalRestante = espacioDestino.wood + espacioDestino.stone + espacioDestino.iron;
            if (totalRestante <= 0) break;
          }
          const origenId = fuente.townId;

          if (!origenInfo || !origenInfo.resources) {
            resumen.fuentes.push({ townId: origenId, motivo: "origen sin datos en MM" });
            continue;
          }
          //Gating inter-isla: mercados nivel <5 solo pueden enviar dentro de
          //la misma isla. Si el nivel del mercado no se pudo detectar
          //(marketLevel==null), no pre-filtramos — el server hará el gating.
          //Si destinoInfo.islandId también es null, asumimos mismo isla y
          //dejamos pasar (no podemos comparar).
          if (
            destinoInfo.islandId != null &&
            origenInfo.islandId != null &&
            destinoInfo.islandId !== origenInfo.islandId &&
            origenInfo.marketLevel != null &&
            origenInfo.marketLevel < MARKET_LEVEL_INTER_ISLA
          ) {
            resumen.fuentes.push({
              townId: origenId,
              motivo: `mercado nivel ${origenInfo.marketLevel} — no puede enviar entre islas (requiere ≥${MARKET_LEVEL_INTER_ISLA})`,
            });
            continue;
          }
          const cap = origenInfo.availableTradeCapacity;
          if (cap == null) {
            resumen.fuentes.push({ townId: origenId, motivo: "origen sin info de mercado en MM" });
            continue;
          }
          if (cap <= 0) {
            resumen.fuentes.push({ townId: origenId, motivo: "sin comerciantes libres", cap });
            continue;
          }
          const stock = origenInfo.resources;
          //Tope por recurso: lo MÍNIMO entre lo que la fuente puede ceder
          //(stock - reserva del grupo) y lo que el destino puede recibir
          //(espacio que queda contando incoming + lo ya mandado en este
          //ciclo). En modo objetivo además respetamos objetivo[r]=0 como
          //"no mandar este recurso a este destino".
          const tope = {};
          for (const r of RECURSOS) {
            const cedible = (stock[r] || 0) - (grupo.reserva[r] || 0);
            let tDest = espacioDestino[r] || 0;
            if (esModoObjetivo && objetivoPorRecurso[r] === 0) tDest = 0;
            tope[r] = Math.max(0, Math.min(cedible, tDest));
          }
          const payload = esModoObjetivo
            ? calcularPayloadObjetivo(cap, tope)
            : calcularPayload(cap, grupo.pesos, tope);
          const sumPayload = payload.wood + payload.stone + payload.iron;
          if (sumPayload <= 0) {
            resumen.fuentes.push({
              townId: origenId,
              motivo: "nada para enviar (stock<reserva o destino lleno por recurso)",
              cap,
            });
            continue;
          }

          const r1 = await enviarComercio(origenId, grupo.destinoTownId, payload);
          if (!r1.ok) {
            data.comercio.ultimoPorGrupoFuente[grupo.id] =
              data.comercio.ultimoPorGrupoFuente[grupo.id] || {};
            data.comercio.ultimoPorGrupoFuente[grupo.id][origenId] = {
              ts: Date.now(), sent: { wood: 0, stone: 0, iron: 0 }, error: r1.error,
            };
            persistir();
            if (r1.probableCaptcha && core.onCaptchaDetectado) {
              core.onCaptchaDetectado({
                feature: "comercio",
                ciudad: { id: origenId, nombre: nombreCiudad(origenId) },
              });
              resumen.fuentes.push({ townId: origenId, motivo: "CAPTCHA detectado, ciclo abortado" });
              break;
            }
            core.logWarn(
              "comercio",
              `${nombreCiudad(origenId)} → ${nombreCiudad(grupo.destinoTownId)}: ${r1.error}`
            );
            resumen.fuentes.push({ townId: origenId, motivo: r1.error });
            continue;
          }

          //Éxito: log + actualizar estado + decrementar espacio local +
          //cachear viajeMs (proxy de distancia para ordenar el próximo ciclo).
          data.comercio.ultimoPorGrupoFuente[grupo.id] =
            data.comercio.ultimoPorGrupoFuente[grupo.id] || {};
          data.comercio.ultimoPorGrupoFuente[grupo.id][origenId] = {
            ts: Date.now(), sent: payload, viajeMs: r1.viajeMs,
          };
          if (Number.isFinite(r1.viajeMs) && r1.viajeMs > 0) {
            grupo.viajeMsPorFuente[origenId] = r1.viajeMs;
          }
          data.comercio.historial.push({
            ts: Date.now(),
            grupoId: grupo.id,
            grupoNombre: grupo.nombre,
            origenId,
            origenNombre: nombreCiudad(origenId),
            destinoId: grupo.destinoTownId,
            destinoNombre: nombreCiudad(grupo.destinoTownId),
            sent: payload,
          });
          while (data.comercio.historial.length > HISTORIAL_MAX) {
            data.comercio.historial.shift();
          }
          for (const r of RECURSOS) {
            espacioDestino[r] = Math.max(0, espacioDestino[r] - (payload[r] || 0));
          }
          resumen.fuentes.push({
            townId: origenId, sent: payload, cap, viajeMs: r1.viajeMs,
            saturada: esOrigenSaturado(origenInfo),
          });

          core.log(
            "comercio",
            `${grupo.nombre} · ${nombreCiudad(origenId)} → ${nombreCiudad(grupo.destinoTownId)}: ` +
            `${payload.wood}M / ${payload.stone}P / ${payload.iron}H (cap ${cap})`,
            "ok"
          );
          persistir();

          //Pequeño espaciado entre fuentes del mismo grupo — patrón
          //consistente con recolección/ataques y evita el patrón
          //"N requests en el mismo ms".
          await core.delaySeconds(0.4 + Math.random() * 0.4);
        }
        data.comercio.ultimoCicloPorGrupo[grupo.id] = resumen;
      } finally {
        ejecutandoCiclo[grupoId] = false;
        //Reagendar siempre, aun en caso de error — el feature solo se detiene
        //cuando el master switch o el grupo se apagan.
        if (data.comercio.habilitada && grupo.enabled) {
          reagendarGrupo(grupo, jitterMs(grupo.intervalSeg * 1000));
        }
      }
    }

    function reanudarTodos() {
      if (!data.comercio.habilitada) return;
      if (core.isCaptchaActive()) return;
      for (const g of data.comercio.grupos) {
        if (!g.enabled) continue;
        //Dispersar el primer arranque en una ventana de 0–3s para no salir
        //todos al mismo tiempo si hay varios grupos.
        const startDelay = Math.floor(Math.random() * 3000);
        reagendarGrupo(g, startDelay);
      }
    }

    //Reacción al toggle del master switch / habilitado por grupo.
    function setHabilitada(v) {
      data.comercio.habilitada = !!v;
      persistir();
      if (!v) {
        cancelarTimers();
        core.log("comercio", "loop detenido por usuario", "warn");
      } else {
        reanudarTodos();
        core.log("comercio", "loop iniciado", "ok");
      }
      rerenderTab();
    }

    //—— Listeners de core ——————————————————————————————————————————————
    core.onCaptcha((active) => {
      if (active) cancelarTimers();
      else reanudarTodos();
    });

    //Comercio es INDEPENDIENTE del play/pause global (mismo patrón que
    //ataques). El usuario decide si quiere comerciar aunque el bot principal
    //esté pausado. Pero si el contexto de extensión se invalida, paramos.
    //No nos enganchamos a onPlayPauseChange — toggle propio.

    //—— Render del tab ———————————————————————————————————————————————
    //
    //Self-contained: usa solo DOM + estilos inline. recoleccion delega vía
    //JamBot.features.comercio.api.renderTab(body) cada ~1s mientras la tab
    //está visible.

    function rerenderTab() {
      const body = document.querySelector("#panelConfigJam .pcj-body");
      if (body && body.querySelector("#comercioPanelMarker")) renderTab(body);
    }

    function fmtTiempoRel(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return `hace ${s}s`;
      if (s < 3600) return `hace ${Math.floor(s / 60)}m ${s % 60}s`;
      return `hace ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }

    function fmtCuenta(ms) {
      const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${m}m ${String(r).padStart(2, "0")}s`;
    }

    //Compacta "1500" → "1.5k", "23000" → "23k" para resumir en el header
    //del grupo sin que se desborde. Solo > 1000.
    function fmtMiles(n) {
      const x = Number(n);
      if (!Number.isFinite(x)) return "?";
      if (x < 1000) return String(x);
      if (x < 10000) return (x / 1000).toFixed(1).replace(/\.0$/, "") + "k";
      return Math.round(x / 1000) + "k";
    }

    function renderTab(body) {
      //Skip refresh si hay foco en un input/select dentro del tab (el usuario
      //está escribiendo). Mismo patrón que ataques.js.
      const ae = document.activeElement;
      if (ae && body.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "SELECT")) {
        return;
      }
      body.innerHTML = "";

      //Marker para que rerenderTab sepa que el tab Comercio está montado.
      const marker = document.createElement("div");
      marker.id = "comercioPanelMarker";
      marker.style.display = "none";
      body.appendChild(marker);

      body.appendChild(renderHeaderMaster());

      const ciudades = (data.ciudadesConAldeas || []).slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );
      if (!ciudades.length) {
        const v = document.createElement("div");
        v.textContent = "Cargando ciudades… (recolección las pobla al boot)";
        v.style.cssText = "opacity:0.7;font-style:italic;padding:10px 0;font-size:11.5px";
        body.appendChild(v);
        return;
      }

      body.appendChild(renderExplicacion());
      body.appendChild(renderSubtitulo("GRUPOS"));
      const lista = document.createElement("div");
      lista.style.cssText = "display:flex;flex-direction:column;gap:8px";
      for (const g of data.comercio.grupos) {
        lista.appendChild(renderCardGrupo(g, ciudades));
      }
      body.appendChild(lista);

      //Botón nuevo grupo
      const nuevo = document.createElement("button");
      nuevo.type = "button";
      nuevo.textContent = "➕ Nuevo grupo";
      nuevo.style.cssText =
        "margin-top:10px;background:#2c3a4d;color:#e6e9ee;border:0;padding:8px 14px;" +
        "cursor:pointer;border-radius:3px;font-size:12px;font-weight:bold;width:100%";
      nuevo.addEventListener("click", () => {
        const id = uuid();
        const g = {
          id,
          nombre: `Grupo ${data.comercio.grupos.length + 1}`,
          destinoTownId: "",
          fuentes: [],
          //Modo objetivo es el default — el usuario típicamente quiere
          //"mantener llena esta ciudad". `objetivo: {null,null,null}` =
          //"hasta el cap del almacén del destino" (sigue al cap si el
          //jugador sube el almacén in-game).
          modo: MODO_DEFAULT_NUEVO,
          objetivo: { wood: null, stone: null, iron: null },
          //pesos sigue presente para compatibilidad del shape — en modo
          //objetivo NO se usa, pero si el usuario cambia a modo
          //"proporcional", quedan listos para configurar.
          pesos: { wood: PESO_DEFAULT, stone: PESO_DEFAULT, iron: PESO_DEFAULT },
          reserva: { wood: 0, stone: 0, iron: 0 },
          viajeMsPorFuente: {},
          intervalSeg: INTERVAL_DEFAULT_SEG,
          enabled: true,
        };
        data.comercio.grupos.push(g);
        data.comercio.uiState.expandidos[id] = true;
        persistir();
        rerenderTab();
      });
      body.appendChild(nuevo);

      body.appendChild(renderHistorialSection());
      body.appendChild(renderTradesEnVueloSection());
    }

    function renderHeaderMaster() {
      const wrap = document.createElement("div");
      const dsc = data.comercio;
      const corriendo = dsc.habilitada && !core.isCaptchaActive();
      wrap.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 12px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${dsc.habilitada ? "#27ae60" : "#7a8aa0"}`;
      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const titulo = document.createElement("div");
      titulo.textContent = "Loop de comercio";
      titulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const sub = document.createElement("div");
      const gActivos = dsc.grupos.filter((g) => g.enabled && g.destinoTownId && g.fuentes.length > 0).length;
      const gTotal = dsc.grupos.length;
      sub.textContent = corriendo
        ? `Activo · ${gActivos}/${gTotal} grupo(s) corriendo`
        : !dsc.habilitada
          ? `Detenido — ${gTotal} grupo(s) configurado(s)`
          : "En espera — CAPTCHA activo";
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      left.appendChild(titulo);
      left.appendChild(sub);
      wrap.appendChild(left);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = (dsc.habilitada ? "⏸  Detener" : "▶  Iniciar");
      const colorBtn = dsc.habilitada ? "#e74c3c" : "#27ae60";
      btn.style.cssText =
        `padding:7px 16px;background:${colorBtn};color:#fff;border:none;` +
        "border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;" +
        "letter-spacing:0.3px;flex-shrink:0";
      btn.addEventListener("click", () => setHabilitada(!dsc.habilitada));
      wrap.appendChild(btn);
      return wrap;
    }

    function renderExplicacion() {
      const v = document.createElement("div");
      v.innerHTML =
        `Cada <b>grupo</b> manda recursos desde N <b>fuentes</b> a un <b>destino</b>. ` +
        `<b>Modo Objetivo</b> (default): fijás cuánto querés tener de cada recurso ` +
        `en el destino (default: hasta el cap del almacén). El bot calcula el ` +
        `faltante <b>descontando lo que ya está en vuelo</b> y prioriza las fuentes ` +
        `saturadas (≥${Math.round(SATURACION_PCT * 100)}% de cap) y las más cercanas. ` +
        `<b>Modo Proporcional</b>: los <b>pesos</b> (0–${PESO_MAX}) deciden el reparto. ` +
        `<b>Reserva</b> es el piso que cada fuente conserva. Si el destino ya cubre ` +
        `el objetivo (contando trades en vuelo), el ciclo se omite.`;
      v.style.cssText =
        "background:#1a232e;border-left:3px solid #3498db;color:#bdc3c7;" +
        "padding:8px 10px;font-size:11.5px;line-height:1.45;border-radius:3px;" +
        "margin:8px 0";
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

    function renderCardGrupo(grupo, ciudades) {
      normalizarGrupo(grupo);
      const card = document.createElement("div");
      const activo = grupo.enabled && grupo.destinoTownId && grupo.fuentes.length > 0;
      card.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${activo ? "#27ae60" : "#7a8aa0"}`;

      //Header (siempre visible, clickeable para expandir/colapsar).
      const header = document.createElement("div");
      header.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;" +
        "user-select:none";
      const expandido = !!data.comercio.uiState.expandidos[grupo.id];
      const flecha = document.createElement("span");
      flecha.textContent = expandido ? "▾" : "▸";
      flecha.style.cssText = "color:#7a8aa0;font-size:11px;width:12px";
      header.appendChild(flecha);
      const tit = document.createElement("div");
      tit.style.cssText = "flex:1;min-width:0";
      const nombre = document.createElement("div");
      nombre.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12px";
      const destNom = grupo.destinoTownId ? nombreCiudad(Number(grupo.destinoTownId)) : "(destino sin elegir)";
      nombre.innerHTML = `${escapeHtml(grupo.nombre)} ` +
        `<span style="color:#7a8aa0;font-weight:normal">→ ${escapeHtml(destNom)}</span>`;
      const sub = document.createElement("div");
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      const resumenModo = grupo.modo === "objetivo"
        ? "obj " + RECURSOS
            .map((r) => grupo.objetivo[r] == null ? "cap" : fmtMiles(grupo.objetivo[r]))
            .join("/")
        : `pesos ${grupo.pesos.wood}/${grupo.pesos.stone}/${grupo.pesos.iron}`;
      sub.textContent =
        `${grupo.fuentes.length} fuente(s) · cada ${grupo.intervalSeg}s · ${resumenModo}`;
      tit.appendChild(nombre);
      tit.appendChild(sub);
      header.appendChild(tit);

      //Toggle enabled del grupo
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.textContent = grupo.enabled ? "ON" : "OFF";
      toggleBtn.title = grupo.enabled ? "Pausa solo este grupo" : "Activa solo este grupo";
      toggleBtn.style.cssText =
        `padding:3px 10px;background:${grupo.enabled ? "#27ae60" : "#5a6776"};color:#fff;` +
        "border:0;cursor:pointer;border-radius:3px;font-size:11px;font-weight:bold";
      toggleBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        grupo.enabled = !grupo.enabled;
        persistir();
        if (data.comercio.habilitada) {
          if (grupo.enabled) reagendarGrupo(grupo, 200);
          else if (timersPorGrupo[grupo.id]) {
            clearTimeout(timersPorGrupo[grupo.id]);
            delete timersPorGrupo[grupo.id];
          }
        }
        rerenderTab();
      });
      header.appendChild(toggleBtn);

      header.addEventListener("click", () => {
        data.comercio.uiState.expandidos[grupo.id] = !expandido;
        rerenderTab();
      });
      card.appendChild(header);

      if (!expandido) return card;

      //Body del grupo cuando está expandido.
      const cuerpo = document.createElement("div");
      cuerpo.style.cssText = "padding:8px 12px;border-top:1px solid #2c3a4d";

      //Línea 1: nombre + destino + intervalo + eliminar
      const fila1 = document.createElement("div");
      fila1.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:10px";

      fila1.appendChild(campoTexto("Nombre", grupo.nombre, (v) => {
        grupo.nombre = v || "Grupo";
        persistir();
      }));

      const destSelect = campoSelect(
        "Destino",
        grupo.destinoTownId ? String(grupo.destinoTownId) : "",
        [{ value: "", label: "— elegir —" }].concat(
          ciudades.map((c) => ({ value: String(c.codigoCiudad), label: c.nombreCiudad }))
        ),
        (v) => {
          grupo.destinoTownId = v ? Number(v) : "";
          //Si el destino quedó en fuentes, sacarlo.
          grupo.fuentes = grupo.fuentes.filter((f) => f.townId !== grupo.destinoTownId);
          persistir();
          rerenderTab();
        }
      );
      fila1.appendChild(destSelect);

      fila1.appendChild(campoNumero(
        "Intervalo (s)",
        grupo.intervalSeg,
        INTERVAL_MIN_SEG, INTERVAL_MAX_SEG,
        (v) => {
          grupo.intervalSeg = Math.min(Math.max(v, INTERVAL_MIN_SEG), INTERVAL_MAX_SEG);
          persistir();
        }
      ));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "🗑 Eliminar";
      delBtn.style.cssText =
        "background:#7a3a3a;color:#fff;border:0;padding:6px 12px;cursor:pointer;" +
        "border-radius:3px;font-size:11px;font-weight:bold;height:28px";
      delBtn.addEventListener("click", () => {
        if (!confirm(`¿Eliminar grupo "${grupo.nombre}"?`)) return;
        if (timersPorGrupo[grupo.id]) {
          clearTimeout(timersPorGrupo[grupo.id]);
          delete timersPorGrupo[grupo.id];
        }
        const idx = data.comercio.grupos.findIndex((x) => x.id === grupo.id);
        if (idx >= 0) data.comercio.grupos.splice(idx, 1);
        delete data.comercio.ultimoPorGrupoFuente[grupo.id];
        delete data.comercio.ultimoCicloPorGrupo[grupo.id];
        delete data.comercio.uiState.expandidos[grupo.id];
        persistir();
        rerenderTab();
      });
      fila1.appendChild(delBtn);

      cuerpo.appendChild(fila1);

      //Línea 2: selector de modo (objetivo/proporcional). Lo separamos del
      //cuerpo de pesos/objetivos para que cambiar el modo sea un re-render
      //que muestre la UI correspondiente.
      cuerpo.appendChild(renderSelectorModo(grupo));

      //Línea 3: pesos+reservas (modo proporcional) u objetivos+reservas
      //(modo objetivo). Ambos comparten "reserva por recurso" — lo que
      //cambia es la columna del medio.
      cuerpo.appendChild(grupo.modo === "objetivo"
        ? renderObjetivosReservas(grupo)
        : renderPesosReservas(grupo));

      //Línea 4: fuentes
      cuerpo.appendChild(renderFuentes(grupo, ciudades));

      //Línea 5: estado por fuente + motivo del último ciclo
      cuerpo.appendChild(renderEstadoFuentes(grupo));

      card.appendChild(cuerpo);
      return card;
    }

    function renderSelectorModo(grupo) {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;align-items:center;gap:10px;margin-bottom:10px;" +
        "padding:6px 10px;background:#1a232e;border:1px solid #2c3a4d;border-radius:3px";
      const lab = document.createElement("div");
      lab.textContent = "MODO";
      lab.style.cssText =
        "color:#7a8aa0;font-size:10.5px;font-weight:bold;text-transform:uppercase;" +
        "letter-spacing:0.8px;min-width:42px";
      wrap.appendChild(lab);
      for (const m of MODOS_VALIDOS) {
        const btn = document.createElement("button");
        btn.type = "button";
        const activo = grupo.modo === m;
        btn.textContent = m === "objetivo" ? "Objetivo" : "Proporcional";
        btn.title = m === "objetivo"
          ? "Llenar el destino hasta un valor por recurso (default = cap del almacén). " +
            "Reparte la capacidad del mercado del origen proporcional a lo que falta."
          : "Pesos por recurso (0-100) deciden cómo se reparte la capacidad del mercado " +
            "del origen. Útil cuando solo querés mover excedente sin un objetivo concreto.";
        btn.style.cssText =
          `padding:4px 12px;font-size:11px;font-weight:bold;cursor:pointer;border-radius:3px;` +
          `border:1px solid ${activo ? "#27ae60" : "#2c3a4d"};` +
          `background:${activo ? "#1e3a2c" : "#0e1620"};` +
          `color:${activo ? "#27ae60" : "#bdc3c7"}`;
        btn.addEventListener("click", () => {
          if (grupo.modo === m) return;
          grupo.modo = m;
          persistir();
          rerenderTab();
        });
        wrap.appendChild(btn);
      }
      const help = document.createElement("div");
      help.style.cssText = "color:#7a8aa0;font-size:10.5px;flex:1;text-align:right";
      help.textContent = grupo.modo === "objetivo"
        ? "Saturadas primero · cercanas después · descuenta trades en vuelo"
        : "Reparte por pesos · descuenta trades en vuelo";
      wrap.appendChild(help);
      return wrap;
    }

    function renderObjetivosReservas(grupo) {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "background:#1a232e;border:1px solid #2c3a4d;border-radius:3px;" +
        "padding:8px 10px;margin-bottom:10px";
      const head = document.createElement("div");
      head.style.cssText =
        "display:flex;align-items:center;gap:8px;color:#7a8aa0;font-size:10.5px;" +
        "font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px";
      const labelHead = document.createElement("span");
      labelHead.style.cssText = "flex:1";
      labelHead.textContent = "Objetivo por recurso (vacío = hasta cap) · Reserva en origen";
      head.appendChild(labelHead);

      //Atajos: "Hasta cap" pone los 3 objetivos en null (= hasta cap del
      //destino dinámicamente). "Cero" pone los 3 en 0 (= no mandar nada).
      const btnCap = document.createElement("button");
      btnCap.type = "button";
      btnCap.textContent = "Hasta cap";
      btnCap.title = "Setear los 3 recursos a 'hasta el cap del almacén' (sigue al cap dinámicamente)";
      btnCap.style.cssText =
        "background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 8px;cursor:pointer;" +
        "border-radius:3px;font-size:10.5px;font-weight:bold";
      btnCap.addEventListener("click", () => {
        for (const r of RECURSOS) grupo.objetivo[r] = null;
        persistir();
        rerenderTab();
      });
      head.appendChild(btnCap);
      wrap.appendChild(head);

      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:80px 1fr 90px;gap:6px 10px;align-items:center";
      for (const r of RECURSOS) {
        const label = document.createElement("div");
        label.innerHTML = `<span style="color:${COLOR_RECURSO[r]};font-weight:bold">${LABEL_RECURSO[r]}</span>`;
        label.style.cssText = "font-size:11.5px";
        grid.appendChild(label);

        //Input numérico para objetivo. Vacío = null = "hasta cap".
        //0 explícito = "no mandar este recurso a este destino" (case útil
        //cuando el destino es una ciudad militar que solo quiere madera).
        const objWrap = document.createElement("div");
        objWrap.style.cssText = "display:flex;align-items:center;gap:6px";
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "0";
        inp.placeholder = "cap";
        inp.value = grupo.objetivo[r] == null ? "" : String(grupo.objetivo[r]);
        inp.title = `Objetivo de ${LABEL_RECURSO[r]} en el destino — vacío = hasta el cap del almacén. ` +
                    `0 = no mandar este recurso a este destino.`;
        inp.style.cssText =
          "flex:1;background:#0e1620;color:#e6e9ee;border:1px solid #2c3a4d;" +
          "padding:5px 7px;border-radius:3px;font-size:11.5px;font-family:monospace;" +
          "height:26px;box-sizing:border-box";
        inp.addEventListener("change", () => {
          const raw = inp.value.trim();
          if (raw === "") {
            grupo.objetivo[r] = null;
          } else {
            const v = Math.max(0, Math.floor(Number(raw) || 0));
            grupo.objetivo[r] = v;
            inp.value = String(v);
          }
          persistir();
          rerenderTab();
        });
        objWrap.appendChild(inp);
        grid.appendChild(objWrap);

        //Reserva en origen (mismo control que en modo proporcional —
        //compartido, no quiero forzar al usuario a re-configurar al
        //cambiar de modo).
        const inpRes = document.createElement("input");
        inpRes.type = "number";
        inpRes.min = "0";
        inpRes.value = String(grupo.reserva[r] || 0);
        inpRes.title = `Reserva mínima de ${LABEL_RECURSO[r]} en la fuente — no se envía si dejaría stock < reserva`;
        inpRes.style.cssText =
          "width:90px;background:#0e1620;color:#e6e9ee;border:1px solid #2c3a4d;" +
          "padding:4px 6px;border-radius:3px;font-size:11px;font-family:monospace";
        inpRes.addEventListener("change", () => {
          const v = Math.max(0, Math.floor(Number(inpRes.value) || 0));
          grupo.reserva[r] = v;
          inpRes.value = String(v);
          persistir();
        });
        grid.appendChild(inpRes);
      }
      wrap.appendChild(grid);
      return wrap;
    }

    function renderPesosReservas(grupo) {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "background:#1a232e;border:1px solid #2c3a4d;border-radius:3px;" +
        "padding:8px 10px;margin-bottom:10px";
      const head = document.createElement("div");
      head.style.cssText = "color:#7a8aa0;font-size:10.5px;font-weight:bold;" +
        "text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px";
      head.textContent = "Pesos por recurso (0–100) · Reserva mínima en origen";
      wrap.appendChild(head);

      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:80px 1fr 90px;gap:6px 10px;align-items:center";
      for (const r of RECURSOS) {
        const label = document.createElement("div");
        label.innerHTML = `<span style="color:${COLOR_RECURSO[r]};font-weight:bold">${LABEL_RECURSO[r]}</span>`;
        label.style.cssText = "font-size:11.5px";
        grid.appendChild(label);

        //Slider de peso + número visible
        const sliderWrap = document.createElement("div");
        sliderWrap.style.cssText = "display:flex;gap:8px;align-items:center";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = String(PESO_MAX);
        slider.value = String(grupo.pesos[r]);
        slider.style.cssText = "flex:1";
        const valBadge = document.createElement("span");
        valBadge.textContent = String(grupo.pesos[r]);
        valBadge.style.cssText =
          "color:#e6e9ee;font-family:monospace;font-size:11px;min-width:28px;text-align:right;font-weight:bold";
        slider.addEventListener("input", () => {
          grupo.pesos[r] = Number(slider.value);
          valBadge.textContent = slider.value;
          persistir();
        });
        sliderWrap.appendChild(slider);
        sliderWrap.appendChild(valBadge);
        grid.appendChild(sliderWrap);

        //Reserva (input numérico)
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "0";
        inp.value = String(grupo.reserva[r] || 0);
        inp.title = `Reserva mínima de ${LABEL_RECURSO[r]} en la fuente — no se envía si dejaría stock < reserva`;
        inp.style.cssText =
          "width:90px;background:#0e1620;color:#e6e9ee;border:1px solid #2c3a4d;" +
          "padding:4px 6px;border-radius:3px;font-size:11px;font-family:monospace";
        inp.addEventListener("change", () => {
          const v = Math.max(0, Math.floor(Number(inp.value) || 0));
          grupo.reserva[r] = v;
          inp.value = String(v);
          persistir();
        });
        grid.appendChild(inp);
      }
      wrap.appendChild(grid);
      return wrap;
    }

    function renderFuentes(grupo, ciudades) {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "background:#1a232e;border:1px solid #2c3a4d;border-radius:3px;" +
        "padding:8px 10px;margin-bottom:10px";
      const head = document.createElement("div");
      head.style.cssText =
        "display:flex;align-items:center;color:#7a8aa0;font-size:10.5px;font-weight:bold;" +
        "text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;gap:8px";
      const labelHead = document.createElement("span");
      labelHead.style.cssText = "flex:1";
      const fuentesIds = new Set(grupo.fuentes.map((f) => f.townId));
      labelHead.textContent = `Fuentes (${fuentesIds.size}/${ciudades.length - (grupo.destinoTownId ? 1 : 0)})`;
      head.appendChild(labelHead);

      const todasBtn = document.createElement("button");
      todasBtn.type = "button";
      todasBtn.textContent = "Todas";
      todasBtn.title = "Seleccionar todas mis ciudades (excepto el destino)";
      todasBtn.style.cssText =
        "background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 8px;cursor:pointer;" +
        "border-radius:3px;font-size:10.5px;font-weight:bold";
      todasBtn.addEventListener("click", () => {
        grupo.fuentes = ciudades
          .filter((c) => c.codigoCiudad !== grupo.destinoTownId)
          .map((c) => ({ townId: c.codigoCiudad }));
        persistir();
        rerenderTab();
      });
      head.appendChild(todasBtn);

      const ningunaBtn = document.createElement("button");
      ningunaBtn.type = "button";
      ningunaBtn.textContent = "Ninguna";
      ningunaBtn.style.cssText =
        "background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 8px;cursor:pointer;" +
        "border-radius:3px;font-size:10.5px;font-weight:bold";
      ningunaBtn.addEventListener("click", () => {
        grupo.fuentes = [];
        persistir();
        rerenderTab();
      });
      head.appendChild(ningunaBtn);
      wrap.appendChild(head);

      const list = document.createElement("div");
      list.style.cssText =
        "display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 10px";
      for (const c of ciudades) {
        if (c.codigoCiudad === grupo.destinoTownId) continue;
        const lab = document.createElement("label");
        lab.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;color:#e6e9ee;cursor:pointer";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = fuentesIds.has(c.codigoCiudad);
        cb.addEventListener("change", () => {
          if (cb.checked) {
            if (!fuentesIds.has(c.codigoCiudad)) grupo.fuentes.push({ townId: c.codigoCiudad });
          } else {
            grupo.fuentes = grupo.fuentes.filter((f) => f.townId !== c.codigoCiudad);
          }
          persistir();
          rerenderTab();
        });
        lab.appendChild(cb);
        const span = document.createElement("span");
        span.textContent = c.nombreCiudad;
        lab.appendChild(span);
        list.appendChild(lab);
      }
      wrap.appendChild(list);
      return wrap;
    }

    function renderEstadoFuentes(grupo) {
      const wrap = document.createElement("div");
      const ult = data.comercio.ultimoPorGrupoFuente[grupo.id] || {};
      const ciclo = data.comercio.ultimoCicloPorGrupo[grupo.id];
      if (ciclo && ciclo.motivo) {
        const v = document.createElement("div");
        v.style.cssText =
          `background:${ciclo.destinoLleno ? "#3a2d1a" : "#1a232e"};` +
          `color:${ciclo.destinoLleno ? "#f1c40f" : "#bdc3c7"};` +
          "padding:6px 10px;border-radius:3px;font-size:11px;margin-bottom:8px;" +
          `border-left:3px solid ${ciclo.destinoLleno ? "#f1c40f" : "#3498db"}`;
        v.innerHTML = `<b>Último ciclo</b> · ${escapeHtml(ciclo.motivo)} · ${fmtTiempoRel(ciclo.ts)}`;
        wrap.appendChild(v);
      }

      if (!grupo.fuentes.length) {
        const v = document.createElement("div");
        v.textContent = "Sin fuentes seleccionadas — no se envía nada.";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11px;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }

      const tabla = document.createElement("div");
      tabla.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:3px;overflow:hidden";
      const head = `
        <tr style="background:#1a232e;color:#7a8aa0;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">
          <th style="padding:5px 8px;text-align:left">Fuente</th>
          <th style="padding:5px 8px;text-align:right" title="Capacidad disponible del mercado de la fuente (recursos por viaje)">Cap libre</th>
          <th style="padding:5px 8px;text-align:right">Último envío</th>
          <th style="padding:5px 8px;text-align:right">Cuándo</th>
        </tr>`;
      let rows = "";
      const fuentesInfo = [];
      for (const f of grupo.fuentes) {
        const u = ult[f.townId];
        const lastErr = u && u.error;
        const sent = u && u.sent;
        const ciudadNombre = nombreCiudad(f.townId);
        const enviadoTxt = lastErr
          ? `<span style="color:#e74c3c" title="${escapeHtml(lastErr)}">err</span>`
          : sent
            ? `<span style="color:${COLOR_RECURSO.wood}">${sent.wood}</span> / ` +
              `<span style="color:${COLOR_RECURSO.stone}">${sent.stone}</span> / ` +
              `<span style="color:${COLOR_RECURSO.iron}">${sent.iron}</span>`
            : `<span style="color:#5a6776">—</span>`;
        const cuando = u ? fmtTiempoRel(u.ts) : `<span style="color:#5a6776">nunca</span>`;
        rows += `
          <tr style="border-top:1px solid #2c3a4d;font-size:11.5px" data-fuente="${f.townId}">
            <td style="padding:5px 8px;color:#e6e9ee">${escapeHtml(ciudadNombre)}</td>
            <td style="padding:5px 8px;text-align:right;color:#bdc3c7;font-family:monospace" data-cap="${f.townId}">…</td>
            <td style="padding:5px 8px;text-align:right;font-family:monospace">${enviadoTxt}</td>
            <td style="padding:5px 8px;text-align:right;color:#7a8aa0;font-size:10.5px">${cuando}</td>
          </tr>`;
        fuentesInfo.push(f.townId);
      }
      tabla.innerHTML = `<table style="width:100%;border-collapse:collapse">${head}${rows}</table>`;
      wrap.appendChild(tabla);

      //Pintar la columna "Cap libre" preguntando al bridge async. No bloquea
      //el render — si el modelo no está en MM, queda en "n/d".
      for (const tid of fuentesInfo) {
        queryTown(tid).then((info) => {
          const cell = wrap.querySelector(`[data-cap="${tid}"]`);
          if (!cell) return;
          if (!info) { cell.textContent = "?"; return; }
          if (info.availableTradeCapacity == null) {
            cell.textContent = "n/d";
            cell.title = "El modelo Town no está cargado en MM aún — pasá por esa ciudad o esperá un ciclo.";
            return;
          }
          const av = info.availableTradeCapacity;
          const mx = info.maxTradeCapacity;
          cell.textContent = mx ? `${av} / ${mx}` : String(av);
          cell.style.color = av > 0 ? "#27ae60" : "#7a8aa0";
        });
      }
      return wrap;
    }

    function renderTradesEnVueloSection() {
      const wrap = document.createElement("div");
      wrap.appendChild(renderSubtitulo("Comercios en vuelo"));
      const ahora = Date.now();
      //Refrescar cache si pasó el TTL.
      const cache = data.comercio.tradesCache;
      if (ahora - cache.ts > TRADES_CACHE_TTL_MS) {
        cache.ts = ahora;
        queryTrades().then((tr) => { cache.trades = tr; });
      }
      const trades = cache.trades || [];
      if (!trades.length) {
        const v = document.createElement("div");
        v.textContent = "Sin comercios activos en este momento.";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11px;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const tabla = document.createElement("div");
      tabla.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:3px;overflow:hidden";
      const head = `
        <tr style="background:#1a232e;color:#7a8aa0;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">
          <th style="padding:5px 8px;text-align:left">Origen</th>
          <th style="padding:5px 8px;text-align:left">Destino</th>
          <th style="padding:5px 8px;text-align:right">Recursos</th>
          <th style="padding:5px 8px;text-align:right">Llega en</th>
        </tr>`;
      let rows = "";
      const ord = trades.slice().sort((a, b) => (a.arrivalAt || 0) - (b.arrivalAt || 0));
      for (const t of ord) {
        const arrivalMs = (t.arrivalAt || 0) * 1000;
        const llega = arrivalMs > ahora ? fmtCuenta(arrivalMs) : "llegando…";
        const recs =
          `<span style="color:${COLOR_RECURSO.wood}">${t.wood}</span> / ` +
          `<span style="color:${COLOR_RECURSO.stone}">${t.stone}</span> / ` +
          `<span style="color:${COLOR_RECURSO.iron}">${t.iron}</span>`;
        rows += `
          <tr style="border-top:1px solid #2c3a4d;font-size:11.5px">
            <td style="padding:5px 8px;color:#e6e9ee">${escapeHtml(nombreCiudad(t.originTownId) || t.originTownName || "?")}</td>
            <td style="padding:5px 8px;color:#e6e9ee">${escapeHtml(nombreCiudad(t.destinationTownId) || "?")}</td>
            <td style="padding:5px 8px;text-align:right;font-family:monospace">${recs}</td>
            <td style="padding:5px 8px;text-align:right;color:#bdc3c7;font-family:monospace">${llega}</td>
          </tr>`;
      }
      tabla.innerHTML = `<table style="width:100%;border-collapse:collapse">${head}${rows}</table>`;
      wrap.appendChild(tabla);
      return wrap;
    }

    function renderHistorialSection() {
      const wrap = document.createElement("div");
      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;margin:14px 0 8px;gap:8px";
      const subt = document.createElement("div");
      subt.textContent = `HISTORIAL (${data.comercio.historial.length})`;
      subt.style.cssText =
        "flex:1;font-size:10.5px;font-weight:bold;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      head.appendChild(subt);
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.textContent = data.comercio.uiState.mostrarHistorial ? "ocultar" : "mostrar";
      toggleBtn.style.cssText =
        "background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 10px;cursor:pointer;" +
        "border-radius:3px;font-size:10.5px;font-weight:bold";
      toggleBtn.addEventListener("click", () => {
        data.comercio.uiState.mostrarHistorial = !data.comercio.uiState.mostrarHistorial;
        rerenderTab();
      });
      head.appendChild(toggleBtn);
      if (data.comercio.historial.length) {
        const clr = document.createElement("button");
        clr.type = "button";
        clr.textContent = "limpiar";
        clr.style.cssText =
          "background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 10px;cursor:pointer;" +
          "border-radius:3px;font-size:10.5px;font-weight:bold";
        clr.addEventListener("click", () => {
          if (!confirm("¿Borrar historial de comercios?")) return;
          data.comercio.historial = [];
          persistir();
          rerenderTab();
        });
        head.appendChild(clr);
      }
      wrap.appendChild(head);
      if (!data.comercio.uiState.mostrarHistorial) return wrap;
      if (!data.comercio.historial.length) {
        const v = document.createElement("div");
        v.textContent = "Sin envíos registrados.";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11.5px;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const lista = document.createElement("div");
      lista.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:3px;" +
        "max-height:200px;overflow-y:auto";
      let html = "";
      const ordenadas = data.comercio.historial.slice().reverse();
      for (const a of ordenadas) {
        const d = new Date(a.ts);
        const hh = String(d.getHours()).padStart(2, "0") + ":" +
                   String(d.getMinutes()).padStart(2, "0") + ":" +
                   String(d.getSeconds()).padStart(2, "0");
        html += `
          <div style="padding:5px 8px;border-top:1px solid #2c3a4d;font-size:11px">
            <span style="color:#7a8aa0;font-family:monospace">${hh}</span> ·
            <b style="color:#e6e9ee">${escapeHtml(a.grupoNombre)}</b> ·
            ${escapeHtml(a.origenNombre || `#${a.origenId}`)} →
            <span style="color:#e6e9ee">${escapeHtml(a.destinoNombre || `#${a.destinoId}`)}</span> ·
            <span style="color:${COLOR_RECURSO.wood}">${a.sent.wood}</span> /
            <span style="color:${COLOR_RECURSO.stone}">${a.sent.stone}</span> /
            <span style="color:${COLOR_RECURSO.iron}">${a.sent.iron}</span>
          </div>`;
      }
      lista.innerHTML = html;
      wrap.appendChild(lista);
      return wrap;
    }

    //—— Helpers UI ——————————————————————————————————————————————————————

    function campoTexto(label, value, onChange) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:1;min-width:140px";
      const lab = document.createElement("div");
      lab.textContent = label;
      lab.style.cssText = "color:#7a8aa0;font-size:10px;text-transform:uppercase;letter-spacing:0.5px";
      wrap.appendChild(lab);
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = value || "";
      inp.style.cssText =
        "background:#0e1620;color:#e6e9ee;border:1px solid #2c3a4d;padding:5px 7px;" +
        "border-radius:3px;font-size:11.5px;height:28px;box-sizing:border-box";
      inp.addEventListener("change", () => onChange(inp.value.trim()));
      wrap.appendChild(inp);
      return wrap;
    }

    function campoSelect(label, value, opciones, onChange) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:1;min-width:160px";
      const lab = document.createElement("div");
      lab.textContent = label;
      lab.style.cssText = "color:#7a8aa0;font-size:10px;text-transform:uppercase;letter-spacing:0.5px";
      wrap.appendChild(lab);
      const sel = document.createElement("select");
      sel.style.cssText =
        "background:#0e1620;color:#e6e9ee;border:1px solid #2c3a4d;padding:5px 7px;" +
        "border-radius:3px;font-size:11.5px;height:28px;box-sizing:border-box";
      for (const op of opciones) {
        const o = document.createElement("option");
        o.value = op.value;
        o.textContent = op.label;
        if (op.value === value) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => onChange(sel.value));
      wrap.appendChild(sel);
      return wrap;
    }

    function campoNumero(label, value, min, max, onChange) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;width:120px";
      const lab = document.createElement("div");
      lab.textContent = label;
      lab.style.cssText = "color:#7a8aa0;font-size:10px;text-transform:uppercase;letter-spacing:0.5px";
      wrap.appendChild(lab);
      const inp = document.createElement("input");
      inp.type = "number";
      inp.value = String(value);
      inp.min = String(min);
      inp.max = String(max);
      inp.style.cssText =
        "background:#0e1620;color:#e6e9ee;border:1px solid #2c3a4d;padding:5px 7px;" +
        "border-radius:3px;font-size:11.5px;height:28px;box-sizing:border-box;font-family:monospace";
      inp.addEventListener("change", () => {
        const v = Math.floor(Number(inp.value) || min);
        const clamped = Math.min(Math.max(v, min), max);
        inp.value = String(clamped);
        onChange(clamped);
      });
      wrap.appendChild(inp);
      return wrap;
    }

    //—— Exposición API + arranque ——————————————————————————————————————
    JamBot.features.comercio = JamBot.features.comercio || {};
    JamBot.features.comercio.api = { renderTab };

    core.log(
      "comercio",
      `iniciado · ${data.comercio.grupos.length} grupo(s) · ${data.comercio.habilitada ? "habilitado" : "detenido"}`,
      "ok"
    );

    if (data.comercio.habilitada) {
      reanudarTodos();
    }
  }

  JamBot.features.comercio = { init };
})();
