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

  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id, townId, player_id } = game;

    //Módulo PREMIUM: sin pwd no arrancamos polls ni timers. El tab
    //"Comercio" tampoco se muestra. Nos suscribimos al evento de unlock
    //para que init() se vuelva a invocar cuando se ingrese la pwd.
    if (!core.isPremiumUnlocked()) {
      core.log("comercio", "bloqueado — sin pwd premium", "warn");
      JamBot.features.comercio.api = { renderTab: core.renderBloqueoEnTab };
      core.onPremiumUnlock(() => init(ctx));
      return;
    }

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
      for (const r of RECURSOS) {
        const p = Number(g.pesos[r]);
        g.pesos[r] = Number.isFinite(p) && p >= 0 ? Math.min(p, PESO_MAX) : PESO_DEFAULT;
        const rs = Number(g.reserva[r]);
        g.reserva[r] = Number.isFinite(rs) && rs >= 0 ? Math.floor(rs) : 0;
      }
      const intv = Number(g.intervalSeg);
      g.intervalSeg = Number.isFinite(intv)
        ? Math.min(Math.max(intv, INTERVAL_MIN_SEG), INTERVAL_MAX_SEG)
        : INTERVAL_DEFAULT_SEG;
      if (typeof g.enabled !== "boolean") g.enabled = true;
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
      const resumen = { ts: ahora, fuentes: [] };

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
        const espacioDestino = {
          wood:  Math.max(0, storage - (destinoInfo.resources.wood  || 0)),
          stone: Math.max(0, storage - (destinoInfo.resources.stone || 0)),
          iron:  Math.max(0, storage - (destinoInfo.resources.iron  || 0)),
        };
        const espacioTotal = espacioDestino.wood + espacioDestino.stone + espacioDestino.iron;
        if (espacioTotal === 0) {
          resumen.destinoLleno = true;
          resumen.motivo = "destino sin espacio en almacén — ciclo omitido";
          data.comercio.ultimoCicloPorGrupo[grupo.id] = resumen;
          return;
        }
        //Solo recursos con peso > 0 cuentan para el "destino lleno por
        //recursos relevantes": si todos los pesos > 0 dan 0 espacio, también
        //salteamos.
        let espacioRelevante = 0;
        for (const r of RECURSOS) {
          if ((grupo.pesos[r] || 0) > 0) espacioRelevante += espacioDestino[r];
        }
        if (espacioRelevante === 0) {
          resumen.destinoLleno = true;
          resumen.motivo = "destino sin espacio en los recursos habilitados — ciclo omitido";
          data.comercio.ultimoCicloPorGrupo[grupo.id] = resumen;
          return;
        }

        //Iterar fuentes. Espacio del destino se decrementa localmente con
        //cada envío exitoso para que la siguiente fuente no se pase
        //(evita refetchear tras cada envío).
        for (const fuente of grupo.fuentes) {
          if (!core.isExtensionContextValid()) break;
          if (core.isCaptchaActive()) break;
          if (!data.comercio.habilitada) break;
          const origenId = fuente.townId;
          if (origenId === grupo.destinoTownId) continue; //no enviarse a sí mismo

          const origenInfo = await queryTown(origenId);
          if (!origenInfo || !origenInfo.resources) {
            resumen.fuentes.push({ townId: origenId, motivo: "origen sin datos en MM" });
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
          const tope = {};
          for (const r of RECURSOS) {
            tope[r] = Math.max(0, Math.min(
              (stock[r] || 0) - (grupo.reserva[r] || 0),
              espacioDestino[r] || 0
            ));
          }
          const payload = calcularPayload(cap, grupo.pesos, tope);
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

          //Éxito: log + actualizar estado + decrementar espacio local.
          data.comercio.ultimoPorGrupoFuente[grupo.id] =
            data.comercio.ultimoPorGrupoFuente[grupo.id] || {};
          data.comercio.ultimoPorGrupoFuente[grupo.id][origenId] = {
            ts: Date.now(), sent: payload, viajeMs: r1.viajeMs,
          };
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
          resumen.fuentes.push({ townId: origenId, sent: payload, cap, viajeMs: r1.viajeMs });

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
          pesos: { wood: PESO_DEFAULT, stone: PESO_DEFAULT, iron: PESO_DEFAULT },
          reserva: { wood: 0, stone: 0, iron: 0 },
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
        `Los <b>pesos</b> (0–${PESO_MAX}) deciden qué porcentaje de la capacidad del mercado se usa ` +
        `para cada recurso (peso 0 = nunca mandar). Si un recurso no alcanza, se ` +
        `rellena con el siguiente con peso > 0. <b>Reserva</b> es el piso que la ` +
        `fuente conserva. Si el destino no tiene espacio en almacén el envío se omite ` +
        `para no desperdiciar recursos.`;
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
      sub.textContent =
        `${grupo.fuentes.length} fuente(s) · cada ${grupo.intervalSeg}s · ` +
        `pesos ${grupo.pesos.wood}/${grupo.pesos.stone}/${grupo.pesos.iron}`;
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

      //Línea 2: pesos + reservas (compactos, en una grilla)
      cuerpo.appendChild(renderPesosReservas(grupo));

      //Línea 3: fuentes
      cuerpo.appendChild(renderFuentes(grupo, ciudades));

      //Línea 4: estado por fuente + motivo del último ciclo
      cuerpo.appendChild(renderEstadoFuentes(grupo));

      card.appendChild(cuerpo);
      return card;
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
