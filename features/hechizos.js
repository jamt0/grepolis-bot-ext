/* features/hechizos.js — spam de poderes divinos sobre commands (ataques
 * entrantes a mis ciudades y salientes míos).
 *
 * El usuario elige un command + un poder divino y el bot intenta castearlo
 * en loop hasta que él lo pause. La cadencia entre intentos es configurable
 * (default 1s). Cada intento exitoso dispara un modal verde toast; cada
 * intento fallido se ve en rojo en el log en tiempo real.
 *
 * Endpoint (capturado del cliente):
 *   POST .../frontend_bridge?town_id=<EMISORA>&action=execute&h=<csrf>
 *   body: json={
 *     model_url: "Commands",
 *     action_name: "cast",
 *     captcha: null,
 *     arguments: { id: <COMMAND_ID>, power_id: "<POWER>" },
 *     town_id: <EMISORA>,
 *     nl_init: true
 *   }
 *
 * `town_id` es la ciudad emisora del cast — tiene que adorar al dios del
 * poder. El favor se descuenta del pool GLOBAL del jugador (PlayerGods).
 *
 * Catálogo de poderes: lo descubrimos del cliente via gameBridge
 * (JamBot:queryPowersCatalog). Si el cliente no expone GameData.powers,
 * tenemos un fallback con el único poder confirmado (effort_of_the_huntress)
 * y le pedimos al usuario que abra el panel "Hechizos" del juego para que
 * el bot capture la info — el bridge la encuentra al recargar la página.
 *
 * Persistencia: slots activos en chrome.storage.local con sufijo _${world_id}.
 * Al cargar el bot, los slots vivos se reanudan si su command sigue activo.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  //—— Constantes ————————————————————————————————————————————————————————

  //Poll de commands: el endpoint `command_overview` ya lo polea
  //`ataquesEntrantes.js` cada 10s, pero ahí filtra solo entrantes. Nosotros
  //queremos también salientes — así que tenemos nuestro propio poll
  //(idéntico endpoint, no es costoso duplicarlo). Cada 10s.
  const POLL_COMMANDS_MS = 10 * 1000;

  //Cadencia entre intentos por slot. El usuario la cambia desde el panel.
  //Acepta decimales (separador `.` — el input HTML es agnóstico de locale).
  //Min 0.1s — abajo de eso el server tira CAPTCHA casi siempre. Max 600s.
  const CADENCIA_DEFAULT_SEG = 1;
  const CADENCIA_MIN_SEG = 0.1;
  const CADENCIA_MAX_SEG = 600;

  //Log de intentos para mostrar en el panel. FIFO.
  const LOG_INTENTOS_MAX = 100;

  //Toast verde de éxito: tiempo visible.
  const TOAST_OK_MS = 4000;

  //Tipos de command que consideramos "ataques" — coincide con la lista de
  //ataquesEntrantes.js. Para salientes filtramos solo estos tipos (no apoyos
  //ni comercios: sobre esos no tiene sentido castear).
  const TIPOS_ATAQUE = new Set([
    "attack",
    "attack_land",
    "attack_sea",
    "attack_takeover",
    "revolt",
    "illusion",
    "portal_attack_olympus",
    "portal_revolt_olympus",
  ]);

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

  //Labels en español de los dioses (para mostrar al usuario).
  const LABEL_DIOS = {
    zeus: "Zeus", poseidon: "Poseidón", hera: "Hera", athena: "Atenea",
    hades: "Hades", artemis: "Artemisa", aphrodite: "Afrodita", ares: "Ares",
  };

  //Fallback de catálogo si el cliente no expone GameData.powers. Solo el
  //único poder confirmado (vimos su cast con éxito en la conversación de
  //implementación). El descubrimiento dinámico via bridge lo sobreescribe
  //cuando el cliente lo tiene cargado.
  const POWERS_FALLBACK = [
    { id: "effort_of_the_huntress", name: "Esfuerzo de la cazadora", god: "artemis", favor: 100, target: "command" },
  ];

  //—— Helpers ————————————————————————————————————————————————————————————

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function jitterMs(baseSeg, frac) {
    //Jitter ±frac (0..1) sobre baseSeg. Ej baseSeg=1, frac=0.2 → 0.8s a 1.2s.
    const min = Math.max(0.05, baseSeg * (1 - frac));
    const max = baseSeg * (1 + frac);
    return (min + Math.random() * (max - min)) * 1000;
  }

  function textoDeAnchor(html) {
    if (!html) return "";
    try {
      const d = document.createElement("div");
      d.innerHTML = String(html);
      return d.textContent || d.innerText || "";
    } catch (_) { return String(html); }
  }

  function fmtHora(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id, townId, player_id } = game;

    //Módulo PREMIUM: sin pwd no arrancamos polls ni timers. El tab
    //"Hechizos" tampoco se muestra. Nos suscribimos al evento de unlock
    //para que init() se vuelva a invocar cuando se ingrese la pwd.
    if (!core.isPremiumUnlocked()) {
      core.log("hechizos", "bloqueado — sin pwd premium", "warn");
      JamBot.features.hechizos.api = { renderTab: core.renderBloqueoEnTab };
      core.onPremiumUnlock(() => init(ctx));
      return;
    }

    const STORAGE_KEY = `jambotHechizos_${world_id}`;

    //—— Estado ————————————————————————————————————————————————————————————
    //
    //  cadenciaSeg:  cada cuántos segundos reintentar (configurable).
    //  slots:        Map<slotKey, slot>   slotKey = `${command_id}|${power_id}`
    //                slot = {
    //                  commandId, powerId, godRequerido, type ("entrante"|"saliente"),
    //                  ciudadEjeId (la ciudad que ancla la card en la UI:
    //                    destino para entrantes, origen para salientes),
    //                  ciudadEjeName,
    //                  pausado: bool,
    //                  exitos, fallos,
    //                  ultimoEstado: "ok"|"fail"|null,
    //                  ultimoMensaje: string|null,
    //                  ultimoTs: number|null,
    //                  timerId: timer del próximo intento (no persiste),
    //                  proximoAt: ms (no persiste),
    //                }
    //  log:          FIFO de últimos intentos { ts, slotKey, ok, mensaje,
    //                                          powerName, commandId, ciudadEjeName }
    //  commands:     vista runtime del último poll
    //                { entrantesPorCiudad: Map<townId,[]>, salientesPorCiudad: Map<townId,[]>}
    //  powers:       catálogo descubierto + fallback
    //  playerGods:   snapshot del bridge: { favor, temples, maxFavor }
    //  townsGods:    Map<townId, dios>

    let cadenciaSeg = CADENCIA_DEFAULT_SEG;
    const slots = new Map();
    let logIntentos = [];
    let powers = POWERS_FALLBACK.slice();
    let playerGods = { favor: {}, temples: {}, maxFavor: null };
    let townsGods = new Map();

    let commands = { entrantesPorCiudad: new Map(), salientesPorCiudad: new Map() };
    let ultimoPollTs = 0;
    let ultimoPollOk = false;
    let ultimoPollError = null;
    let commandsVivos = new Set(); //set de ids del último poll, para detectar slots huérfanos
    //ts del último render del tab — sirve como "usuario está mirando esta tab".
    //Si renderTab corrió hace <2s, el tab está activo (recoleccion lo invoca
    //cada 1s mientras está visible). Si no, no gastamos HTTP en el poll.
    let ultimoRenderTs = 0;
    //Referencia al PRIMER elemento que renderTab agrega al body del panel.
    //Sirve de "ancla" para detectar si Hechizos sigue siendo la tab activa:
    //cuando el usuario cambia a otra tab, recoleccion hace `body.innerHTML = ""`
    //y el ancla desaparece. Re-renders externos (pollCommands, ejecutarIntento)
    //chequean `body.contains(ultimoAnclaRender)` antes de tocar el body — así
    //evitan pisar Dashboard/otras tabs con contenido de Hechizos.
    let ultimoAnclaRender = null;

    //—— Persistencia ————————————————————————————————————————————————————

    let saveTimer = null;
    function persistir() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        if (!core.isExtensionContextValid()) return;
        try {
          const slotsPlain = [];
          for (const s of slots.values()) {
            slotsPlain.push({
              commandId: s.commandId,
              powerId: s.powerId,
              godRequerido: s.godRequerido,
              type: s.type,
              ciudadEjeId: s.ciudadEjeId,
              ciudadEjeName: s.ciudadEjeName,
              originTownName: s.originTownName || null,
              destTownName: s.destTownName || null,
              pausado: !!s.pausado,
              exitos: s.exitos | 0,
              fallos: s.fallos | 0,
              ultimoEstado: s.ultimoEstado || null,
              ultimoMensaje: s.ultimoMensaje || null,
              ultimoTs: s.ultimoTs || null,
            });
          }
          chrome.storage.local.set({
            [STORAGE_KEY]: {
              cadenciaSeg,
              slots: slotsPlain,
              log: logIntentos.slice(-LOG_INTENTOS_MAX),
            },
          });
        } catch (e) {
          core.logWarn("hechizos", "no pude persistir estado", e);
        }
      }, 300);
    }

    await new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (obj) => {
          const blob = (obj && obj[STORAGE_KEY]) || {};
          if (typeof blob.cadenciaSeg === "number" && blob.cadenciaSeg >= CADENCIA_MIN_SEG && blob.cadenciaSeg <= CADENCIA_MAX_SEG) {
            cadenciaSeg = blob.cadenciaSeg;
          }
          if (Array.isArray(blob.log)) logIntentos = blob.log.slice(-LOG_INTENTOS_MAX);
          if (Array.isArray(blob.slots)) {
            //Rehidratamos slots persistidos. Los timers no persisten — se
            //arrancan al primer poll cuando confirmamos que el command sigue
            //vivo. Si murió, se descarta en sincronizarConPoll().
            for (const s of blob.slots) {
              if (!s || !s.commandId || !s.powerId) continue;
              const key = `${s.commandId}|${s.powerId}`;
              slots.set(key, {
                commandId: s.commandId,
                powerId: s.powerId,
                godRequerido: s.godRequerido || null,
                type: s.type || "entrante",
                ciudadEjeId: s.ciudadEjeId || null,
                ciudadEjeName: s.ciudadEjeName || null,
                originTownName: s.originTownName || null,
                destTownName: s.destTownName || null,
                pausado: !!s.pausado,
                exitos: s.exitos | 0,
                fallos: s.fallos | 0,
                ultimoEstado: s.ultimoEstado || null,
                ultimoMensaje: s.ultimoMensaje || null,
                ultimoTs: s.ultimoTs || null,
                timerId: null,
                proximoAt: null,
              });
            }
          }
          resolve();
        });
      } catch (_) { resolve(); }
    });

    //—— Bridge queries ———————————————————————————————————————————————————

    function queryViaBridge(eventOut, typeIn, payload) {
      return new Promise((resolve) => {
        const handler = (e) => {
          if (e.source !== window) return;
          const m = e.data;
          if (!m || m.type !== typeIn) return;
          window.removeEventListener("message", handler);
          clearTimeout(toid);
          resolve(m.data);
        };
        window.addEventListener("message", handler);
        const toid = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 2000);
        window.dispatchEvent(new CustomEvent(eventOut, { detail: payload || {} }));
      });
    }

    async function refrescarPlayerGods() {
      const d = await queryViaBridge("JamBot:queryPlayerGods", "JamBot:playerGodsResult");
      if (d) playerGods = d;
    }

    async function refrescarTownsGods() {
      const d = await queryViaBridge("JamBot:queryTownsGods", "JamBot:townsGodsResult");
      if (d && typeof d === "object") {
        const m = new Map();
        for (const k of Object.keys(d)) m.set(Number(k), d[k]);
        townsGods = m;
      }
    }

    async function queryActiveTown() {
      const d = await queryViaBridge("JamBot:queryActiveTown", "JamBot:activeTownResult");
      return d && d.townId != null ? Number(d.townId) : null;
    }

    async function changeActiveTown(townId) {
      return new Promise((resolve) => {
        const handler = (e) => {
          if (e.source !== window) return;
          const m = e.data;
          if (!m || m.type !== "JamBot:changeTownResult") return;
          window.removeEventListener("message", handler);
          clearTimeout(toid);
          resolve(!!(m && m.ok));
        };
        window.addEventListener("message", handler);
        const toid = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(false);
        }, 2000);
        window.dispatchEvent(new CustomEvent("JamBot:changeTown", { detail: { townId } }));
      });
    }

    async function refrescarPowers() {
      const d = await queryViaBridge("JamBot:queryPowersCatalog", "JamBot:powersCatalogResult");
      if (Array.isArray(d) && d.length) {
        //Filtramos solo poderes castreables sobre command. Si el cliente no
        //expone target en algunos, los incluímos igual — el server avisará
        //si está mal y el usuario verá el error.
        const completos = d.filter((p) => !p.target || p.target === "command");
        if (completos.length) powers = completos;
      }
    }

    //—— Poll de commands ———————————————————————————————————————————————

    async function pollCommands() {
      if (!core.isExtensionContextValid()) return;
      if (core.isCaptchaActive()) return;

      //Endpoint global de commands. REQUIERE Administrator premium — sin él
      //el server responde {error:"Necesitas al administrador..."} y el poll
      //falla en silencio. El caso sin Admin queda pendiente (intentamos via
      //modelos Backbone pero MovementsUnits solo expone la ciudad activa).
      const url =
        `https://${world_id}.grepolis.com/game/town_overviews` +
        `?town_id=${townId}&action=command_overview&h=${csrfToken}` +
        `&json=${encodeURIComponent(JSON.stringify({ town_id: townId, nl_init: true }))}` +
        `&_=${Date.now()}`;
      let body;
      try {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "text/plain, */*; q=0.01" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.json();
        ultimoPollOk = true;
        ultimoPollError = null;
      } catch (e) {
        ultimoPollOk = false;
        ultimoPollError = e.message;
        core.logWarn("hechizos", `poll falló: ${e.message}`);
        return;
      } finally {
        ultimoPollTs = Date.now();
      }

      //Re-dispatch para que el cliente del juego mantenga sus modelos al día.
      const notifs = body && body.json && body.json.notifications;
      if (Array.isArray(notifs) && notifs.length) {
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: notifs },
        }));
      }

      const j = body && body.json;
      const d = j && j.data;
      if (!d) return;
      const myPlayerId = d.player_id != null ? d.player_id : player_id;
      const cmds = Array.isArray(d.commands) ? d.commands : [];
      //Usamos el mapa `attack_types` que el server manda en cada response
      //(mismo patrón que ataquesEntrantes.js). Es la fuente de verdad de qué
      //tipos cuentan como ataque — más robusto que un Set hardcoded que
      //envejece con cada release del juego. Solo fallback al Set local si el
      //server no manda el mapa.
      const attackTypes = (d.attack_types && typeof d.attack_types === "object") ? d.attack_types : null;
      function esAtaque(tipo) {
        if (attackTypes) return Object.prototype.hasOwnProperty.call(attackTypes, tipo);
        return TIPOS_ATAQUE.has(tipo);
      }

      const entrantesPorCiudad = new Map();
      const salientesPorCiudad = new Map();
      const vivos = new Set();
      let totalConsiderados = 0, totalEntrantes = 0, totalSalientes = 0, totalDescartados = 0;

      for (const c of cmds) {
        if (!c || c.return) continue;
        const tipo = c.type;
        if (!esAtaque(tipo)) { totalDescartados += 1; continue; }
        totalConsiderados += 1;
        const destPid = Number(c.destination_town_player_id);
        const origPid = Number(c.origin_town_player_id);
        const me = Number(myPlayerId);
        const esMioEntrante = destPid === me;
        const esMioSaliente = origPid === me;
        if (!esMioEntrante && !esMioSaliente) continue;
        vivos.add(String(c.id));

        const item = {
          id: c.id,
          type: tipo,
          originTownId: c.origin_town_id,
          originTownName: c.origin_town_name || textoDeAnchor(c.townurl_base64_origin),
          originPlayerName: c.origin_town_player_name || textoDeAnchor(c.userurl_base64_origin),
          destTownId: c.destination_town_id,
          destTownName: c.destination_town_name || textoDeAnchor(c.townurl_base64_destination),
          destPlayerName: c.destination_town_player_name || textoDeAnchor(c.userurl_base64_destination),
          arrivalAt: c.arrival_at,
          startedAt: c.started_at,
        };

        if (esMioEntrante) {
          const tid = Number(item.destTownId);
          if (!entrantesPorCiudad.has(tid)) entrantesPorCiudad.set(tid, []);
          entrantesPorCiudad.get(tid).push(item);
          totalEntrantes += 1;
        } else {
          const tid = Number(item.originTownId);
          if (!salientesPorCiudad.has(tid)) salientesPorCiudad.set(tid, []);
          salientesPorCiudad.get(tid).push(item);
          totalSalientes += 1;
        }
      }

      commands = { entrantesPorCiudad, salientesPorCiudad };
      commandsVivos = vivos;

      //Diagnóstico: log breve con el conteo. Si el usuario dice "no detecta
      //ataques" pero acá ve totalEntrantes > 0, el bug está en el render;
      //si es 0 con cmds.length > 0, el bug está en el filtro.
      core.log(
        "hechizos",
        `poll: ${cmds.length} commands · ${totalConsiderados} ataque(s) · entrantes=${totalEntrantes} · salientes=${totalSalientes} · descartados (no-ataque)=${totalDescartados}`
      );

      //Repintar el panel si está abierto Y el usuario está en la tab Hechizos
      //(rerenderSiTabActiva chequea el ancla — evita pisar Dashboard/otras
      //tabs con contenido de hechizos cuando un slot castea en background).
      rerenderSiTabActiva();

      //Refrescar info auxiliar también (favor + dios por ciudad). Esto no
      //hace HTTP — solo lee modelos Backbone, es barato.
      refrescarPlayerGods().catch(() => {});
      refrescarTownsGods().catch(() => {});

      //Sincronizar slots con la realidad: si un command desapareció (ya
      //llegó o fue cancelado), su slot se detiene y se elimina.
      sincronizarSlotsConPoll();
    }

    function sincronizarSlotsConPoll() {
      const aRemover = [];
      for (const [key, s] of slots) {
        if (!commandsVivos.has(String(s.commandId))) {
          //Command ya no existe — detener slot.
          if (s.timerId) { clearTimeout(s.timerId); s.timerId = null; }
          aRemover.push(key);
          core.log("hechizos", `slot #${s.commandId}/${s.powerId} retirado: el ataque ya no existe`, "warn");
        } else if (!s.pausado && !s.timerId) {
          //Slot persistido que aún no arrancó su loop — arrancarlo.
          agendarProximoIntento(s);
        }
      }
      for (const k of aRemover) slots.delete(k);
      if (aRemover.length) persistir();
    }

    //—— Send cast ————————————————————————————————————————————————————————

    function elegirCiudadEmisora(slot) {
      //Cualquier ciudad propia puede ser emisora del cast — NO hace falta
      //que adore al dios del hechizo. El favor se descuenta del pool global
      //del jugador (PlayerGods.production_overview), y mientras al menos
      //UNA ciudad de la cuenta tenga templo del dios (eso es `temples_for_gods`),
      //hay favor disponible y el cast es válido desde cualquier ciudad.
      //
      //Lo único que necesita coincidir es la ciudad "abierta" en el cliente
      //sin Administrator. Por eso priorizamos la ciudad-eje del slot:
      //   - Saliente → ciudad ORIGEN del ataque (de donde sale).
      //   - Entrante → ciudad DESTINO del ataque (la nuestra que recibe).
      //Cuando el usuario casteó manualmente sobre ese ataque alguna vez, esa
      //ciudad fue su contexto activo — replicarlo da máxima compatibilidad
      //sin Administrator.
      const ejeId = slot && slot.ciudadEjeId ? Number(slot.ciudadEjeId) : null;
      if (ejeId) return ejeId;

      //Slot sin ciudad-eje (caso defensivo, no debería pasar) — primera
      //ciudad propia.
      const ciudades = (data.ciudadesConAldeas || []);
      return ciudades.length ? Number(ciudades[0].codigoCiudad) : null;
    }

    async function enviarCast(slot) {
      const emisora = elegirCiudadEmisora(slot);
      if (!emisora) {
        return {
          ok: false,
          mensaje: "No hay ciudades propias detectadas — esperá a que carguen",
          noCastable: true,
        };
      }

      //Sin Administrator, el server exige que la ciudad emisora del cast sea
      //la "abierta" en el cliente. Si no coincide, cambiamos primero — el
      //bridge llama al helper interno del juego (HelperTown.switchTown o
      //similar). Esperamos un toque (350ms) para que el cambio se propague
      //antes del POST del cast.
      try {
        const activa = await queryActiveTown();
        if (activa != null && Number(activa) !== Number(emisora)) {
          await changeActiveTown(emisora);
          await new Promise((r) => setTimeout(r, 350));
        }
      } catch (_) { /* defensivo — si el bridge falla, seguimos con el cast */ }

      const json = {
        model_url: "Commands",
        action_name: "cast",
        captcha: null,
        arguments: { id: slot.commandId, power_id: slot.powerId },
        town_id: emisora,
        nl_init: true,
      };
      const datos = new URLSearchParams();
      datos.append("json", JSON.stringify(json));

      let response;
      try {
        const res = await fetch(
          `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${emisora}&action=execute&h=${csrfToken}`,
          {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              accept: "text/plain, */*; q=0.01",
            },
            body: datos,
          }
        );
        response = await res.json();
      } catch (e) {
        return { ok: false, mensaje: `fetch falló: ${e.message || e}` };
      }

      const j = response && response.json;
      if (j && j.notifications) {
        //Mantenemos los modelos del cliente sincronizados (PlayerGods se
        //actualiza ahí — favor descontado, etc.).
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: j.notifications },
        }));
      }

      if (j && j.success) {
        return { ok: true, mensaje: String(j.success) };
      }
      const err = (j && j.error) ? String(j.error) : "respuesta sin success ni error";

      //Heurística CAPTCHA: si NO hay error reconocible Y no hay
      //notifications, lo más probable es challenge anti-bot. Igual que ataques.
      const tieneNotifs = j && Array.isArray(j.notifications) && j.notifications.length > 0;
      const errorEsTexto = j && typeof j.error === "string" && j.error.length > 0;
      if (!tieneNotifs && !errorEsTexto && core.onCaptchaDetectado) {
        core.onCaptchaDetectado({ feature: "hechizos" });
      }
      return { ok: false, mensaje: err };
    }

    //—— Slots ————————————————————————————————————————————————————————————

    function powerInfo(powerId) {
      return powers.find((p) => p.id === powerId) || { id: powerId, name: powerId, god: null };
    }

    function crearSlot({ command, powerId, type }) {
      const p = powerInfo(powerId);
      const ciudadEjeId = type === "entrante" ? Number(command.destTownId) : Number(command.originTownId);
      const ciudadEjeName = type === "entrante" ? command.destTownName : command.originTownName;
      const slot = {
        commandId: command.id,
        powerId,
        godRequerido: p.god || null,
        type,
        ciudadEjeId,
        ciudadEjeName,
        //Origen y destino del propio movimiento (no de la perspectiva del jugador) —
        //sirven para que el log de cada intento diga claramente "Jam0 → Cerys"
        //sin importar si el ataque es entrante o saliente.
        originTownName: command.originTownName || null,
        destTownName: command.destTownName || null,
        pausado: false,
        exitos: 0,
        fallos: 0,
        ultimoEstado: null,
        ultimoMensaje: null,
        ultimoTs: null,
        timerId: null,
        proximoAt: null,
      };
      const key = `${slot.commandId}|${slot.powerId}`;
      if (slots.has(key)) {
        //Ya existe — reactivar si estaba pausado.
        const existente = slots.get(key);
        if (existente.pausado) {
          existente.pausado = false;
          agendarProximoIntento(existente);
        }
        return existente;
      }
      slots.set(key, slot);
      agendarProximoIntento(slot);
      persistir();
      return slot;
    }

    function pausarSlot(key) {
      const s = slots.get(key);
      if (!s) return;
      s.pausado = true;
      if (s.timerId) { clearTimeout(s.timerId); s.timerId = null; }
      s.proximoAt = null;
      persistir();
    }

    function reanudarSlot(key) {
      const s = slots.get(key);
      if (!s) return;
      s.pausado = false;
      agendarProximoIntento(s);
      persistir();
    }

    function quitarSlot(key) {
      const s = slots.get(key);
      if (!s) return;
      if (s.timerId) { clearTimeout(s.timerId); s.timerId = null; }
      slots.delete(key);
      persistir();
    }

    function agendarProximoIntento(slot) {
      if (slot.timerId) { clearTimeout(slot.timerId); slot.timerId = null; }
      if (slot.pausado) return;
      if (core.isCaptchaActive()) return; //se reagendará cuando se resuelva
      //Sin jitter — el usuario pidió precisión (excepción para hechizos: la
      //feature spamea contra commands específicos y la ventana de timing
      //importa más que la dispersión anti-fingerprint).
      const ms = Math.max(50, cadenciaSeg * 1000);
      slot.proximoAt = Date.now() + ms;
      slot.timerId = setTimeout(() => ejecutarIntento(slot), ms);
    }

    async function ejecutarIntento(slot) {
      slot.timerId = null;
      slot.proximoAt = null;
      if (slot.pausado) return;
      if (core.isCaptchaActive()) return;
      if (!commandsVivos.has(String(slot.commandId))) {
        //Command murió entre poll y tick — slot se limpia en próximo poll.
        return;
      }

      const r = await enviarCast(slot);
      const ts = Date.now();
      slot.ultimoTs = ts;
      slot.ultimoEstado = r.ok ? "ok" : "fail";
      slot.ultimoMensaje = r.mensaje || null;

      const p = powerInfo(slot.powerId);
      const entrada = {
        ts,
        slotKey: `${slot.commandId}|${slot.powerId}`,
        ok: !!r.ok,
        mensaje: r.mensaje || "",
        powerName: p.name || slot.powerId,
        commandId: slot.commandId,
        ciudadEjeName: slot.ciudadEjeName || `#${slot.ciudadEjeId}`,
      };
      logIntentos.push(entrada);
      while (logIntentos.length > LOG_INTENTOS_MAX) logIntentos.shift();

      //Etiqueta de ruta para el log: "Jam0 → Cerys" siempre que tengamos los
      //nombres en el slot. Si falta alguno (slots viejos persistidos antes de
      //este cambio), caemos al ciudadEjeName que sí está garantizado.
      const ruta = (slot.originTownName && slot.destTownName)
        ? `${slot.originTownName} → ${slot.destTownName}`
        : (slot.ciudadEjeName || `#${slot.ciudadEjeId || "?"}`);
      const flecha = slot.type === "entrante" ? "(entrante)" : "(saliente)";
      if (r.ok) {
        slot.exitos = (slot.exitos | 0) + 1;
        core.log("hechizos", `✓ ${p.name} ${flecha} ${ruta} · #${slot.commandId}: ${r.mensaje}`, "ok");
        mostrarToastExito(entrada);
      } else {
        slot.fallos = (slot.fallos | 0) + 1;
        core.logWarn("hechizos", `✗ ${p.name} ${flecha} ${ruta} · #${slot.commandId}: ${r.mensaje}`);
      }
      persistir();

      //Repintar el panel SOLO si el usuario está en la tab Hechizos. Sin esta
      //guarda, un slot casteando en background pisaba el contenido de Dashboard
      //u otra tab donde estuviera el usuario, dándole impresión de "se cambió
      //solo de tab al spamear".
      rerenderSiTabActiva();

      //Re-agendar siguiente intento — no importa si OK o fail, el usuario
      //quiere spamear hasta pausar.
      if (!r.noCastable) {
        agendarProximoIntento(slot);
      } else {
        //noCastable = la config del jugador no permite este cast (sin
        //ciudad que adore el dios). Pausamos para evitar loop infinito de
        //errores idénticos.
        slot.pausado = true;
        persistir();
      }
    }

    //—— Toast verde de éxito ————————————————————————————————————————————

    let toastContainer = null;
    function asegurarToastContainer() {
      if (toastContainer && document.body.contains(toastContainer)) return toastContainer;
      toastContainer = document.createElement("div");
      toastContainer.id = "jambot-hechizos-toasts";
      toastContainer.style.cssText =
        "position:fixed;bottom:24px;right:24px;z-index:99999;" +
        "display:flex;flex-direction:column;gap:8px;align-items:flex-end;" +
        "pointer-events:none";
      document.body.appendChild(toastContainer);
      return toastContainer;
    }

    function mostrarToastExito(entrada) {
      const cont = asegurarToastContainer();
      const card = document.createElement("div");
      card.style.cssText =
        "min-width:260px;max-width:380px;background:#0f1a13;border:1px solid #27ae60;" +
        "border-left:4px solid #27ae60;color:#e6e9ee;padding:10px 12px;border-radius:4px;" +
        "box-shadow:0 4px 14px rgba(0,0,0,0.5);font-family:'Segoe UI',sans-serif;" +
        "font-size:12px;line-height:1.4;pointer-events:auto;transform:translateX(20px);" +
        "opacity:0;transition:opacity 0.2s ease,transform 0.2s ease";
      card.innerHTML =
        `<div style="color:#27ae60;font-weight:bold;font-size:12.5px;margin-bottom:3px">` +
        `✓ ${escapeHtml(entrada.powerName)}` +
        `</div>` +
        `<div style="color:#cdd5e0">${escapeHtml(entrada.mensaje)}</div>` +
        `<div style="color:#7a8aa0;font-size:10.5px;margin-top:4px">` +
        `→ ${escapeHtml(entrada.ciudadEjeName)} (#${entrada.commandId}) · ${fmtHora(entrada.ts)}` +
        `</div>`;
      cont.appendChild(card);
      requestAnimationFrame(() => {
        card.style.opacity = "1";
        card.style.transform = "translateX(0)";
      });
      setTimeout(() => {
        card.style.opacity = "0";
        card.style.transform = "translateX(20px)";
        setTimeout(() => { try { card.remove(); } catch (_) {} }, 250);
      }, TOAST_OK_MS);
    }

    //—— Render del panel ————————————————————————————————————————————————

    function fmtCountdown(arrivalAt) {
      if (!arrivalAt) return "—";
      const seg = Math.round(arrivalAt - Date.now() / 1000);
      if (seg <= 0) return "ya llegó";
      return core.formatDuracion(seg);
    }

    function renderHeader() {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 12px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${core.isCaptchaActive() ? "#e74c3c" : "#9b59b6"}`;
      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const titulo = document.createElement("div");
      titulo.textContent = "Hechizos sobre ataques";
      titulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const sub = document.createElement("div");
      const activos = Array.from(slots.values()).filter((s) => !s.pausado).length;
      const totalSlots = slots.size;
      sub.textContent = core.isCaptchaActive()
        ? "En espera — CAPTCHA activo"
        : `${activos} slot(s) activo(s) · ${totalSlots} total · poll cada ${POLL_COMMANDS_MS/1000}s`;
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      left.appendChild(titulo);
      left.appendChild(sub);
      wrap.appendChild(left);
      return wrap;
    }

    function renderConfig() {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:8px 12px;margin-top:8px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px";
      const lbl = document.createElement("label");
      lbl.textContent = "Cadencia entre intentos (segundos):";
      lbl.style.cssText = "color:#cdd5e0;font-size:11.5px";
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = String(CADENCIA_MIN_SEG);
      inp.max = String(CADENCIA_MAX_SEG);
      inp.step = "0.1";
      inp.value = String(cadenciaSeg);
      inp.style.cssText =
        "width:80px;padding:5px 8px;background:#0f1620;color:#e6e9ee;" +
        "border:1px solid #2c3a4d;border-radius:3px;font-size:12px;font-family:monospace";
      inp.addEventListener("focus", () => { inp.style.borderColor = "#9b59b6"; });
      inp.addEventListener("blur", () => {
        inp.style.borderColor = "#2c3a4d";
        //Decimales aceptados — separador `.` (el input HTML es agnóstico de
        //locale). Redondeamos a 0.1s para evitar que números raros tipo
        //0.123456 ensucien el storage.
        const raw = Number(inp.value);
        const v = Number.isFinite(raw) ? raw : CADENCIA_DEFAULT_SEG;
        const n = Math.max(CADENCIA_MIN_SEG, Math.min(CADENCIA_MAX_SEG, Math.round(v * 10) / 10));
        if (n !== cadenciaSeg) {
          cadenciaSeg = n;
          inp.value = String(n);
          persistir();
        }
      });
      const hint = document.createElement("span");
      hint.textContent = "Cuanto más bajo, más rápido pero más riesgo de CAPTCHA.";
      hint.style.cssText = "color:#7a8aa0;font-size:10.5px;font-style:italic;margin-left:auto";
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      wrap.appendChild(hint);
      return wrap;
    }

    function renderFavorChips() {
      //Pequeño widget de favor por dios disponible — informativo, ayuda al
      //usuario a saber si tiene tropa de favor para spamear.
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;flex-wrap:wrap;gap:6px;padding:6px 12px;margin-top:8px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px";
      const lbl = document.createElement("span");
      lbl.textContent = "Favor:";
      lbl.style.cssText = "color:#7a8aa0;font-size:11px;font-weight:bold;margin-right:4px;align-self:center";
      wrap.appendChild(lbl);
      const dioses = ["zeus", "poseidon", "hera", "athena", "hades", "artemis", "aphrodite", "ares"];
      for (const g of dioses) {
        const tieneTemplo = !!(playerGods.temples && playerGods.temples[g]);
        if (!tieneTemplo) continue;
        const fav = Math.floor(Number((playerGods.favor && playerGods.favor[g]) || 0));
        const max = playerGods.maxFavor || 500;
        const lleno = fav >= max * 0.9;
        const chip = document.createElement("span");
        chip.style.cssText =
          "padding:3px 8px;border-radius:11px;font-size:10.5px;font-family:monospace;" +
          `background:${lleno ? "#1a2e1f" : "#1c2733"};color:${lleno ? "#27ae60" : "#cdd5e0"};` +
          "border:1px solid #2c3a4d";
        chip.textContent = `${LABEL_DIOS[g] || g}: ${fav}/${max}`;
        wrap.appendChild(chip);
      }
      if (wrap.children.length === 1) {
        const v = document.createElement("span");
        v.textContent = "(sin templos detectados)";
        v.style.cssText = "color:#7a8aa0;font-size:10.5px;font-style:italic";
        wrap.appendChild(v);
      }
      return wrap;
    }

    function renderCardsCiudades() {
      const cont = document.createElement("div");
      cont.style.cssText = "display:flex;flex-direction:column;gap:10px;margin-top:12px";

      //Construimos el set de townIds con actividad — desde los commands del
      //poll (entrantes/salientes) y desde los slots existentes. Antes
      //iterábamos `data.ciudadesConAldeas`, pero ese array depende de que
      //recoleccion ya haya corrido y se haya populado; si no, no veíamos NADA
      //aunque el poll trajera ataques. Ahora el render funciona stand-alone.
      const tidsActivos = new Set();
      for (const tid of commands.entrantesPorCiudad.keys()) tidsActivos.add(Number(tid));
      for (const tid of commands.salientesPorCiudad.keys()) tidsActivos.add(Number(tid));
      for (const s of slots.values()) if (s.ciudadEjeId) tidsActivos.add(Number(s.ciudadEjeId));

      //Mapa townId → nombre de ciudad. Combinamos varias fuentes (orden de
      //prioridad): data.ciudadesConAldeas (cuando recoleccion lo populó),
      //destTownName/originTownName del propio command (siempre disponible).
      const nombreCiudad = (tid) => {
        const fromData = (data.ciudadesConAldeas || []).find((c) => Number(c.codigoCiudad) === tid);
        if (fromData && fromData.nombreCiudad) return fromData.nombreCiudad;
        const ent = commands.entrantesPorCiudad.get(tid);
        if (ent && ent.length && ent[0].destTownName) return ent[0].destTownName;
        const sal = commands.salientesPorCiudad.get(tid);
        if (sal && sal.length && sal[0].originTownName) return sal[0].originTownName;
        const slotMatch = Array.from(slots.values()).find((s) => Number(s.ciudadEjeId) === tid);
        if (slotMatch && slotMatch.ciudadEjeName) return slotMatch.ciudadEjeName;
        return `#${tid}`;
      };

      if (!tidsActivos.size) {
        const v = document.createElement("div");
        const ultimoTxt = ultimoPollTs
          ? `último poll hace ${Math.round((Date.now() - ultimoPollTs)/1000)}s${ultimoPollOk ? "" : ` (${ultimoPollError || "?"})`}`
          : "esperando primer poll…";
        v.textContent = `Sin ataques activos ahora — ${ultimoTxt}.`;
        v.style.cssText = "opacity:0.7;font-style:italic;padding:10px;font-size:11.5px;text-align:center";
        cont.appendChild(v);
        return cont;
      }

      //Ordenar por nombre de ciudad (numeric:true para que "Ciudad 2" venga
      //antes que "Ciudad 10").
      const tidsOrdenados = Array.from(tidsActivos).sort((a, b) =>
        nombreCiudad(a).localeCompare(nombreCiudad(b), undefined, { numeric: true })
      );

      for (const tid of tidsOrdenados) {
        const ent = commands.entrantesPorCiudad.get(tid) || [];
        const sal = commands.salientesPorCiudad.get(tid) || [];

        const card = document.createElement("div");
        card.style.cssText =
          "background:#172029;border:1px solid #2c3a4d;border-radius:4px;overflow:hidden";

        const head = document.createElement("div");
        head.style.cssText =
          "padding:8px 12px;background:#1a232e;border-bottom:1px solid #2c3a4d;" +
          "display:flex;align-items:center;gap:8px";
        const nombre = document.createElement("div");
        nombre.style.cssText = "flex:1;color:#e6e9ee;font-weight:bold;font-size:12px";
        const dios = townsGods.get(tid);
        const diosTxt = dios ? ` · ${LABEL_DIOS[dios] || dios}` : "";
        nombre.textContent = `${nombreCiudad(tid)}${diosTxt}`;
        head.appendChild(nombre);
        card.appendChild(head);

        const body = document.createElement("div");
        body.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:8px";

        body.appendChild(renderSeccionCommands("Entrantes", ent, "entrante", tid));
        body.appendChild(renderSeccionCommands("Salientes", sal, "saliente", tid));

        card.appendChild(body);
        cont.appendChild(card);
      }

      return cont;
    }

    function renderSeccionCommands(titulo, lista, tipo, tid) {
      const wrap = document.createElement("div");
      const head = document.createElement("div");
      head.textContent = `${titulo} (${lista.length})`;
      head.style.cssText =
        "color:#7a8aa0;font-size:10px;font-weight:bold;text-transform:uppercase;" +
        "letter-spacing:0.5px;margin-bottom:4px";
      wrap.appendChild(head);

      if (!lista.length) {
        const v = document.createElement("div");
        v.textContent = "—";
        v.style.cssText = "color:#5a6776;font-size:11px;font-style:italic;padding:2px 0";
        wrap.appendChild(v);
        return wrap;
      }

      for (const cmd of lista.slice().sort((a, b) => (a.arrivalAt || 0) - (b.arrivalAt || 0))) {
        wrap.appendChild(renderFilaCommand(cmd, tipo, tid));
      }
      return wrap;
    }

    function renderFilaCommand(cmd, tipo, tid) {
      const row = document.createElement("div");
      row.style.cssText =
        "background:#0f1620;border:1px solid #2c3a4d;border-radius:3px;padding:7px 9px;" +
        "display:flex;flex-direction:column;gap:6px";

      //Línea 1: tipo · contraparte · countdown
      const linea1 = document.createElement("div");
      linea1.style.cssText = "display:flex;align-items:baseline;gap:8px;font-size:11.5px";
      const tipoSpan = document.createElement("span");
      tipoSpan.textContent = LABEL_TIPO[cmd.type] || cmd.type;
      const critico = cmd.type === "attack_takeover" || cmd.type === "revolt";
      tipoSpan.style.cssText = `color:${tipo === "entrante" ? (critico ? "#e74c3c" : "#f39c12") : "#3498db"};font-weight:bold`;
      const contraparte = document.createElement("span");
      contraparte.style.cssText = "color:#cdd5e0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      if (tipo === "entrante") {
        contraparte.innerHTML = `← <b>${escapeHtml(cmd.originPlayerName || "?")}</b> <span style="color:#7a8aa0">desde ${escapeHtml(cmd.originTownName || "?")}</span>`;
      } else {
        contraparte.innerHTML = `→ <b>${escapeHtml(cmd.destPlayerName || "?")}</b> <span style="color:#7a8aa0">en ${escapeHtml(cmd.destTownName || "?")}</span>`;
      }
      const llega = document.createElement("span");
      llega.style.cssText = "color:#e6e9ee;font-family:monospace;font-size:11px";
      llega.textContent = `llega en ${fmtCountdown(cmd.arrivalAt)}`;
      const idTxt = document.createElement("span");
      idTxt.style.cssText = "color:#5a6776;font-family:monospace;font-size:10px";
      idTxt.textContent = `#${cmd.id}`;
      linea1.appendChild(tipoSpan);
      linea1.appendChild(contraparte);
      linea1.appendChild(llega);
      linea1.appendChild(idTxt);
      row.appendChild(linea1);

      //Línea 2: form para agregar slot
      const linea2 = document.createElement("div");
      linea2.style.cssText = "display:flex;gap:6px;align-items:center";
      const sel = document.createElement("select");
      sel.style.cssText =
        "flex:1;min-width:0;padding:4px 6px;background:#0f1620;color:#e6e9ee;" +
        "border:1px solid #2c3a4d;border-radius:3px;font-size:11px";
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = powers.length ? "— elegí un hechizo —" : "(catálogo no detectado)";
      sel.appendChild(opt0);
      //Ordenar por dios para que sea fácil escanear. String() defensivo:
      //si por algún motivo el bridge devolvió god/name como objeto, no rompe
      //el render y el peor caso es que aparezca "[object Object]".
      const ordenadas = powers.slice().sort((a, b) => {
        const ag = String(a.god || "zzz"), bg = String(b.god || "zzz");
        if (ag !== bg) return ag.localeCompare(bg);
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
      for (const p of ordenadas) {
        const o = document.createElement("option");
        o.value = p.id;
        const g = LABEL_DIOS[p.god] || p.god || "?";
        const cost = p.favor != null ? ` · ${p.favor}` : "";
        //Marcamos en gris las que no podemos castear (sin templo del dios).
        const disponible = !p.god || (playerGods.temples && playerGods.temples[p.god]);
        o.textContent = `${disponible ? "" : "⚠ "}${p.name} (${g})${cost}`;
        if (!disponible) o.style.color = "#7a8aa0";
        sel.appendChild(o);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "+ Iniciar spam";
      btn.style.cssText =
        "padding:5px 10px;background:#9b59b6;color:#fff;border:0;border-radius:3px;" +
        "cursor:pointer;font-size:11px;font-weight:bold;flex-shrink:0";
      btn.addEventListener("click", () => {
        if (!sel.value) { sel.focus(); return; }
        crearSlot({ command: cmd, powerId: sel.value, type: tipo });
        rerenderTab();
      });
      linea2.appendChild(sel);
      linea2.appendChild(btn);
      row.appendChild(linea2);

      //Slots activos sobre este command
      const slotsCmd = Array.from(slots.values()).filter((s) => s.commandId === cmd.id);
      for (const s of slotsCmd) {
        row.appendChild(renderSlotActivo(s));
      }

      return row;
    }

    function renderSlotActivo(slot) {
      const wrap = document.createElement("div");
      const colorBorde = slot.pausado ? "#7a8aa0" : (slot.ultimoEstado === "ok" ? "#27ae60" : slot.ultimoEstado === "fail" ? "#e74c3c" : "#9b59b6");
      wrap.style.cssText =
        "padding:6px 8px;background:#0a1218;border-radius:3px;" +
        `border-left:3px solid ${colorBorde};display:flex;flex-direction:column;gap:3px`;

      const linea = document.createElement("div");
      linea.style.cssText = "display:flex;align-items:center;gap:8px;font-size:11px";
      const p = powerInfo(slot.powerId);
      const titulo = document.createElement("span");
      titulo.style.cssText = "flex:1;min-width:0;color:#e6e9ee;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      titulo.textContent = `${p.name}`;
      const estado = document.createElement("span");
      estado.style.cssText = "color:#7a8aa0;font-family:monospace;font-size:10.5px";
      const stat = slot.pausado ? "pausado" : `cada ~${cadenciaSeg}s`;
      estado.textContent = `${stat} · ✓ ${slot.exitos | 0} · ✗ ${slot.fallos | 0}`;
      linea.appendChild(titulo);
      linea.appendChild(estado);
      const key = `${slot.commandId}|${slot.powerId}`;
      const btnP = document.createElement("button");
      btnP.type = "button";
      btnP.textContent = slot.pausado ? "▶" : "⏸";
      btnP.title = slot.pausado ? "Reanudar" : "Pausar";
      btnP.style.cssText =
        "padding:2px 8px;background:#2c3a4d;color:#cdd5e0;border:0;border-radius:3px;" +
        "cursor:pointer;font-size:11px;font-weight:bold";
      btnP.addEventListener("click", () => {
        if (slot.pausado) reanudarSlot(key); else pausarSlot(key);
        rerenderTab();
      });
      const btnQ = document.createElement("button");
      btnQ.type = "button";
      btnQ.textContent = "✕";
      btnQ.title = "Quitar slot";
      btnQ.style.cssText =
        "padding:2px 7px;background:#2c3a4d;color:#cdd5e0;border:0;border-radius:3px;" +
        "cursor:pointer;font-size:11px;font-weight:bold";
      btnQ.addEventListener("click", () => {
        quitarSlot(key);
        rerenderTab();
      });
      linea.appendChild(btnP);
      linea.appendChild(btnQ);
      wrap.appendChild(linea);

      if (slot.ultimoEstado && slot.ultimoMensaje) {
        const msj = document.createElement("div");
        const c = slot.ultimoEstado === "ok" ? "#27ae60" : "#e74c3c";
        const icono = slot.ultimoEstado === "ok" ? "✓" : "✗";
        msj.style.cssText = `color:${c};font-size:10.5px;font-family:monospace;` +
          "white-space:normal;word-break:break-word";
        const hace = slot.ultimoTs ? ` · ${fmtHora(slot.ultimoTs)}` : "";
        msj.textContent = `${icono} ${slot.ultimoMensaje}${hace}`;
        wrap.appendChild(msj);
      }

      return wrap;
    }

    function renderLog() {
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-top:14px";

      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;margin-bottom:6px";
      const subt = document.createElement("div");
      subt.textContent = "ÚLTIMOS INTENTOS (tiempo real)";
      subt.style.cssText =
        "flex:1;font-size:10.5px;font-weight:bold;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      head.appendChild(subt);
      if (logIntentos.length) {
        const clr = document.createElement("button");
        clr.textContent = "limpiar";
        clr.style.cssText =
          "margin-left:8px;background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 10px;" +
          "cursor:pointer;border-radius:3px;font-size:11px;font-weight:bold";
        clr.addEventListener("click", () => {
          logIntentos = [];
          persistir();
          rerenderTab();
        });
        head.appendChild(clr);
      }
      wrap.appendChild(head);

      if (!logIntentos.length) {
        const v = document.createElement("div");
        v.textContent = "Sin intentos aún.";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11.5px;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }

      const lista = document.createElement("div");
      lista.id = "hechizosLogLista";
      lista.style.cssText =
        "background:#0a1218;border:1px solid #2c3a4d;border-radius:3px;" +
        "max-height:280px;overflow-y:auto;font-family:monospace;font-size:11px";
      let html = "";
      for (const e of logIntentos.slice().reverse()) {
        const c = e.ok ? "#27ae60" : "#e74c3c";
        const icono = e.ok ? "✓" : "✗";
        html += `
          <div style="padding:4px 8px;border-top:1px solid #1a232e;color:${c};
                      white-space:normal;word-break:break-word">
            <span style="color:#7a8aa0">${fmtHora(e.ts)}</span>
            <b style="margin:0 6px">${icono}</b>
            <span style="color:#cdd5e0">${escapeHtml(e.powerName)}</span>
            <span style="color:#7a8aa0"> → ${escapeHtml(e.ciudadEjeName)} #${e.commandId}</span>
            <span style="display:block;margin-left:16px;color:${c}">${escapeHtml(e.mensaje)}</span>
          </div>
        `;
      }
      lista.innerHTML = html;
      wrap.appendChild(lista);
      return wrap;
    }

    //—— renderTab (entry-point para el panel) ——————————————————————————

    function rerenderTab() {
      //Disparado por botones del propio panel (iniciar/pausar/quitar slot).
      //Si el usuario los clickea, está en la tab — pero igual chequeamos
      //el ancla por consistencia.
      rerenderSiTabActiva();
    }

    function renderTab(body, soft) {
      //Detectamos "tab recién abierta": si el último renderTab fue hace >2s,
      //es porque el usuario acaba de entrar al tab (click en Jam, o switch
      //desde otra tab). En ese momento disparamos el ÚNICO poll de la
      //sesión-en-este-tab. Mientras la tab queda abierta, recoleccion sigue
      //llamando renderTab cada 1s para el reloj/UI, pero no gatilla más HTTP.
      const ahora = Date.now();
      const tabReciénAbierta = (ahora - ultimoRenderTs) > 2000;
      ultimoRenderTs = ahora;
      if (tabReciénAbierta) {
        pollCommands().catch((e) => core.logError("hechizos", "poll on-open falló", e));
      }
      //Si hay foco en un input/select → saltar el re-render entero. Si no
      //hacemos esto, el tick de 1s del interval (que llama renderTab sin
      //soft) destruye el `<select>` mientras el usuario lo tiene abierto y
      //el dropdown se cierra solo cada segundo, haciéndolo imposible de
      //usar. Cualquier render (auto o manual) respeta el foco.
      void soft;
      const ae = document.activeElement;
      if (ae && body.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "SELECT")) {
        return;
      }
      //Preservar scroll del log entre rerenders (re-render cada intento)
      const listaPrev = body.querySelector("#hechizosLogLista");
      const scrollPrev = listaPrev ? listaPrev.scrollTop : 0;

      body.innerHTML = "";
      const header = renderHeader();
      body.appendChild(header);
      ultimoAnclaRender = header; //ver "ultimoAnclaRender" arriba
      body.appendChild(renderConfig());
      body.appendChild(renderFavorChips());
      body.appendChild(renderCardsCiudades());
      body.appendChild(renderLog());

      if (scrollPrev) {
        const listaNew = body.querySelector("#hechizosLogLista");
        if (listaNew) listaNew.scrollTop = scrollPrev;
      }
    }

    //Helper compartido para los re-renders externos: solo escribe en el body
    //si Hechizos sigue siendo la tab activa (su ancla sigue insertada). Si
    //el usuario cambió de tab, el ancla desapareció y devolvemos false.
    function rerenderSiTabActiva() {
      const body = document.querySelector("#panelConfigJam .pcj-body");
      if (!body) return false;
      if (!ultimoAnclaRender || !body.contains(ultimoAnclaRender)) return false;
      try { renderTab(body, /*soft=*/true); } catch (_) {}
      return true;
    }

    //—— CAPTCHA ————————————————————————————————————————————————————————
    //
    //Al detectarse CAPTCHA pausamos todos los timers (las features que
    //hacen requests durante un challenge dan errores en cadena). Cuando
    //se resuelve, reanudamos los que no estén pausados por el usuario.

    core.onCaptcha((active) => {
      if (active) {
        for (const s of slots.values()) {
          if (s.timerId) { clearTimeout(s.timerId); s.timerId = null; }
          s.proximoAt = null;
        }
      } else {
        for (const s of slots.values()) {
          if (!s.pausado) agendarProximoIntento(s);
        }
      }
    });

    //—— Arranque ———————————————————————————————————————————————————————

    //Descubrir catálogo de poderes una sola vez al boot. Si el cliente lo
    //tiene cargado, perfecto; si no, queda el fallback con effort_of_the_huntress.
    refrescarPowers().catch(() => {});

    //Sin polling periódico — el usuario pidió que la llamada se haga solo
    //cuando entra al tab Hechizos (por click en Jam, o navegando al tab).
    //`renderTab` detecta la transición "tab recién abierta" y dispara una
    //única llamada. Mientras la tab queda abierta, no hay más HTTP.
    //Trade-off conocido: si un slot está casteando y su command muere mientras
    //la tab está cerrada, el slot sigue intentando hasta que el usuario abre
    //el panel y se hace cleanup.

    core.log("hechizos", `iniciado (poll on-demand al abrir tab, cadencia spam ${cadenciaSeg}s) · ${slots.size} slot(s) rehidratado(s)`, "ok");

    JamBot.features.hechizos.api = { renderTab };
  }

  JamBot.features.hechizos = { init };
})();
