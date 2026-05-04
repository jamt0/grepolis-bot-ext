/* features/recoleccion.js — recolección de recursos en aldeas (farm towns).
 *
 * Mantiene el comportamiento previo del bot: al hacer click en su botón se
 * dispara un ciclo que recorre todas las ciudades y reclama recursos en
 * cada aldea. Tras terminar reagenda el siguiente ciclo según
 * data.tiempoRecoleccion (con margen) o 30s si hay CAPTCHA activo.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  /**
   * Inicializa la feature. `ctx` viene del core.init() y tiene
   * { data, game: {csrfToken, world_id, townId, player_id}, core: {…} }.
   */
  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id, townId } = game;

    //—— Estado de la feature ———————————————————————————————————————————

    const ciudadesConAldeas = [];
    const recursosPrevPorCiudad = {};
    //Última vez que cada ALDEA individual fue claimada con éxito. Clave =
    //farm_town_id (aldea.id). El cooldown server es por aldea, no por
    //ciudad: si un ciclo se corta a mitad por CAPTCHA, las aldeas que
    //quedaron sin claimar se retoman en el próximo ciclo (no esperan a que
    //la ciudad entera vuelva a estar disponible).
    //
    //Persiste en chrome.storage.local namespaceado por world_id — sin esto,
    //un reload de la pestaña reseteaba este map a {} y el primer ciclo
    //post-reload disparaba todas las aldeas asumiendo cooldown=0 (el server
    //rechazaba todas con success:false). El namespace por mundo evita que
    //IDs de un mundo contaminen otro si el usuario salta entre cuentas.
    const STORAGE_KEY_LAST_CLAIM = `jambotLastClaimAt_${world_id}`;
    let lastClaimAtPorAldea = {};

    //—— Historial por aldea + último ciclo ——————————————————————————————
    //
    //HISTORIAL_MAX = 36 últimos intentos por aldea (FIFO, los obsoletos se
    //descartan automáticamente en registrarClaim). 36 = ~6 horas a un ciclo
    //cada 10min: alcanza para revisar la noche/mañana anterior. Para 50
    //ciudades: 50 × 6 × 36 × ~250 B ≈ 2.7 MB, ≈ 27% de la cuota
    //chrome.storage.local (10 MB) — holgado.
    //
    //Estructuras:
    //  historialPorAldea[aldeaId] = [{ts, ciudadId, ciudadNombre,
    //                                 aldeaNombre, ciclo, status,
    //                                 dW, dS, dI, intentos, errorMsg}]
    //  ultimoCiclo  = { n, inicio, fin, duracion, captchaDurante,
    //                   ciudades: { [id]: { nombre, claims, esperado,
    //                                       wood, stone, iron,
    //                                       aldeasFalladas: [...] } } }
    //  cicloActual  = igual a ultimoCiclo pero `fin/duracion` null mientras
    //                 el ciclo está corriendo. Se promueve a ultimoCiclo al
    //                 terminar.
    const HISTORIAL_MAX = 36;
    const STORAGE_KEY_HISTORIAL = `jambotHistorial_${world_id}`;
    let historialPorAldea = {};
    let ultimoCiclo = null;
    let cicloActual = null;
    let proximoTickId = null;
    //Timestamp del próximo tick programado — el panel lo usa para mostrar
    //un countdown. null cuando no hay tick programado (pausado o en curso).
    let proximoTickAt = null;
    //Interval handle para el auto-refresh del header del panel mientras está
    //abierto. null cuando el panel está cerrado.
    let intervalActualizarPanel = null;
    //Contador de ciclos desde el bootstrap (no persiste). Sirve para que el
    //log de cada ciclo lleve un número incremental y sea fácil correlacionar
    //claims, tandas y cierre con un mismo "CICLO #N".
    let nCiclo = 0;

    //—— Carga inicial ———————————————————————————————————————————————————
    //
    //Cargamos primero los datos del juego y recién después insertamos el
    //botón. Si el usuario lo clickea con la lista vacía no haría nada útil.

    core.log("recoleccion", "obteniendo info...");
    await obtenerCiudadesConAldeas();
    data.relacionPorAldea = await obtenerMapaRelaciones();
    //Config por ciudad persistida en chrome.storage.local. Cada entrada:
    //{ minutos: 5|10, opcion: 1|2 }. Sin override → se usa el default de
    //data.json (opcionRecoleccion / tiempoRecoleccion).
    const configPorCiudad = await cargarConfigPorCiudad();
    //Restaurar el map de lastClaimAt persistido del mundo actual. Si el
    //bot estuvo corriendo y la pestaña se recargó, esto evita que el primer
    //ciclo dispare aldeas con cooldown server vivo.
    lastClaimAtPorAldea = await cargarLastClaimAt();
    //Restaurar historial + último ciclo. Sobreviven al reload para que el
    //panel de Recolección muestre datos significativos en cuanto se abre,
    //sin esperar al primer ciclo nuevo.
    const histData = await cargarHistorial();
    historialPorAldea = histData.porAldea;
    ultimoCiclo = histData.ultimoCiclo;
    core.log(
      "recoleccion",
      `carga OK · ciudades=${ciudadesConAldeas.length} · relaciones=${Object.keys(data.relacionPorAldea || {}).length} · configCiudades=${Object.keys(configPorCiudad).length} · lastClaimAt persistidos=${Object.keys(lastClaimAtPorAldea).length} · historial=${Object.keys(historialPorAldea).length} aldeas`,
      "ok"
    );

    //—— Storage de config por ciudad ———————————————————————————————————

    function cargarConfigPorCiudad() {
      return new Promise((resolve) => {
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfg = (obj && obj.jambotConfig && obj.jambotConfig.porCiudad) || {};
          resolve(cfg);
        });
      });
    }

    function guardarConfigPorCiudad() {
      //Merge contra lo que haya en storage para no pisar otras claves
      //(e.g. finalizarHabilitado del toggle del panel).
      return new Promise((resolve) => {
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfgPrev = (obj && obj.jambotConfig) || {};
          chrome.storage.local.set(
            { jambotConfig: { ...cfgPrev, porCiudad: configPorCiudad } },
            resolve
          );
        });
      });
    }

    //—— Storage de lastClaimAt por mundo ————————————————————————————————

    function cargarLastClaimAt() {
      return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY_LAST_CLAIM, (obj) => {
          resolve((obj && obj[STORAGE_KEY_LAST_CLAIM]) || {});
        });
      });
    }

    //Fire-and-forget: persistimos sin awaitear para no frenar el ciclo.
    //chrome.storage.local set es ~1ms, despreciable. Si una escritura falla
    //(quota, etc) el siguiente claim sobrescribe — no hace falta retry.
    function guardarLastClaimAt() {
      try {
        chrome.storage.local.set({ [STORAGE_KEY_LAST_CLAIM]: lastClaimAtPorAldea });
      } catch (e) {
        core.logWarn("recoleccion", "no pude persistir lastClaimAt", e);
      }
    }

    //—— Storage de historial + último ciclo ——————————————————————————————

    function cargarHistorial() {
      return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY_HISTORIAL, (obj) => {
          const blob = (obj && obj[STORAGE_KEY_HISTORIAL]) || {};
          resolve({
            porAldea: blob.porAldea || {},
            ultimoCiclo: blob.ultimoCiclo || null,
          });
        });
      });
    }

    function guardarHistorial() {
      try {
        chrome.storage.local.set({
          [STORAGE_KEY_HISTORIAL]: {
            porAldea: historialPorAldea,
            ultimoCiclo: ultimoCiclo,
          },
        });
      } catch (e) {
        core.logWarn("recoleccion", "no pude persistir historial", e);
      }
    }

    /**
     * Registra una entrada en el historial de la aldea. Mantiene FIFO con
     * cap HISTORIAL_MAX. Persiste fire-and-forget. Llamar desde TODOS los
     * exits de recolectarAldea + path de "saltada por cooldown" — así el
     * historial refleja qué pasó con cada aldea cada ciclo, no solo cuándo
     * fue el último claim exitoso.
     */
    function registrarClaim(entrada) {
      const id = entrada.aldeaId;
      if (id == null) return;
      let arr = historialPorAldea[id];
      if (!arr) {
        arr = [];
        historialPorAldea[id] = arr;
      }
      arr.push({ ts: Date.now(), ...entrada });
      while (arr.length > HISTORIAL_MAX) arr.shift();
      guardarHistorial();
    }

    function limpiarHistorial() {
      historialPorAldea = {};
      ultimoCiclo = null;
      cicloActual = null;
      try {
        chrome.storage.local.remove(STORAGE_KEY_HISTORIAL);
      } catch (e) {
        core.logWarn("recoleccion", "no pude limpiar historial", e);
      }
      core.log("recoleccion", "historial limpiado", "ok");
    }

    function limpiarLastClaimAt() {
      lastClaimAtPorAldea = {};
      try {
        chrome.storage.local.remove(STORAGE_KEY_LAST_CLAIM);
      } catch (e) {
        core.logWarn("recoleccion", "no pude limpiar lastClaimAt", e);
      }
      core.log("recoleccion", "sincronización con server reseteada", "ok");
    }

    function exportarHistorial() {
      const blob = {
        world_id,
        exportadoEn: new Date().toISOString(),
        ultimoCiclo,
        porAldea: historialPorAldea,
      };
      const json = JSON.stringify(blob, null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `jambot-historial-${world_id}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      core.log("recoleccion", "historial exportado", "ok");
    }


    function getConfigCiudad(codigoCiudad) {
      const override = configPorCiudad[codigoCiudad];
      const minutos =
        override && (override.minutos === 5 || override.minutos === 10)
          ? override.minutos
          : data.tiempoRecoleccion || 5;
      //IMPORTANTE: option=1 SIEMPRE — es el primer botón "Recoger" del juego,
      //el más corto y más rentable. Su duración real depende de si la ciudad
      //estudió la habilidad de academia "Lealtad de los Aldeanos" (duplica
      //tiempos, +115% recursos): sin habilidad rinde 5min, con habilidad
      //rinde 10min. La elección 5/10 del panel sirve para que el usuario
      //le indique al bot el cooldown real de cada ciudad. Las opciones 2-4
      //del juego (10/20/4h sin habilidad, 40min/3h/8h con habilidad) no se
      //usan nunca: rinden peor por hora y se acumula riesgo de almacén lleno.
      return { minutos, opcion: 1 };
    }

    /**
     * Retorna el tiempo (en minutos) que debe usar el ciclo global del bot.
     * Es el MÍNIMO entre todos los tiempos configurados por ciudad — así
     * el bot tickea con la frecuencia de la ciudad más rápida y deja que
     * el cooldown gating salte a las que aún están bloqueadas. Si no hay
     * ciudades configuradas, usa el default de data.json.
     */
    function tiempoCicloMinutos() {
      let min = Infinity;
      for (const ciudad of ciudadesConAldeas) {
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        if (cfg.minutos < min) min = cfg.minutos;
      }
      return min === Infinity ? data.tiempoRecoleccion || 5 : min;
    }

    //—— Anti-CAPTCHA: helpers de aleatoriedad ——————————————————————————
    //
    //La detección bot del juego se dispara por *patrones*: intervalos exactos,
    //orden fijo de aldeas, mismo payload repetido. Estos helpers rompen esos
    //ejes:
    //  - jitter() varía el tiempo entre claims y entre ciclos
    //  - shuffle() Fisher-Yates baraja ciudades y aldeas en cada ciclo
    //
    //Tradeoff: yields un poquito menores (los tiempos se estiran ~1-2s por
    //claim) a cambio de huella mucho menos detectable.

    function jitter(minMs, maxMs) {
      return minMs + Math.random() * (maxMs - minMs);
    }

    function shuffle(arr) {
      const copia = arr.slice();
      for (let i = copia.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copia[i], copia[j]] = [copia[j], copia[i]];
      }
      return copia;
    }

    function delayMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    //—— UI ——————————————————————————————————————————————————————————————

    const boton = core.registrarBoton({
      id: "botonRecolectarRecursos",
      label: "▶",
      onClick: () => core.togglePlayPause(),
    });
    pintarEstadoBoton("pausado");

    //Reaccionar al play/pause global: cancelar tick al pausar, arrancar al
    //despausar. El estado se sincroniza con `core.isPaused()`.
    core.onPlayPauseChange((p) => {
      if (p) {
        if (proximoTickId) clearTimeout(proximoTickId);
        if (watchdogId) clearTimeout(watchdogId);
        proximoTickId = null;
        proximoTickAt = null;
        watchdogId = null;
        pintarEstadoBoton("pausado");
      } else {
        pintarEstadoBoton("corriendo");
        recolectarRecursos();
      }
    });

    //Botón ⚙ + panel de config por ciudad
    const panelConfig = crearPanelConfig();
    core.registrarBoton({
      id: "botonConfigJam",
      label: "⚙",
      onClick: () => togglePanelConfig(panelConfig),
    });

    //Indicador en tiempo real bajo los botones — muestra "🍎 X/Y ciudades ·
    //A/B aldeas" mientras hay un ciclo en curso. Se inserta en el mismo
    //contenedor que registra core (#jambot-buttons) para heredar layout y
    //zIndex. Oculto cuando no hay ciclo en curso.
    let indicadorVivoEl = null;
    function asegurarIndicadorVivo() {
      if (indicadorVivoEl) return indicadorVivoEl;
      const cont = document.getElementById("jambot-buttons");
      if (!cont) return null;
      indicadorVivoEl = document.createElement("div");
      indicadorVivoEl.id = "jambot-indicador-vivo";
      indicadorVivoEl.style.cssText =
        "padding:5px 9px;background:#1f2a36;color:#cdd5e0;border:1px solid #2c3a4d;" +
        "border-radius:4px;font-family:'Segoe UI',sans-serif;font-size:11px;" +
        "font-weight:bold;letter-spacing:0.3px;display:none;white-space:nowrap;" +
        "box-shadow:0 2px 6px rgba(0,0,0,0.3)";
      cont.appendChild(indicadorVivoEl);
      return indicadorVivoEl;
    }

    function actualizarIndicadorVivo() {
      const el = asegurarIndicadorVivo();
      if (!el) return;
      if (!cicloActual) {
        el.style.display = "none";
        return;
      }
      const c = cicloActual;
      el.style.display = "block";
      el.innerHTML =
        `<span style="color:#e74c3c">🍎</span> ` +
        `<span style="color:#3498db">${c.ciudadesCompletadas}/${c.totalCiudades}</span> ciudades · ` +
        `<span style="color:#3498db">${c.aldeasCompletadas}/${c.totalAldeas}</span> aldeas`;
    }

    //—— Panel ⚙ con tabs (Settings · Recolección) ———————————————————————
    //
    //Estructura DOM (estable, no se re-crea — solo se actualiza el body):
    //   #panelConfigJam
    //     .pcj-titulo        "JamBot"
    //     .pcj-header        Estado + Próximo ciclo (refresh 1s)
    //     .pcj-tabs          [ Settings ] [ Recolección ]   tab persistente
    //     .pcj-body          contenido del tab activo (re-render 1s)
    //
    //Auto-refresh: setInterval 1s que repinta header + body del tab activo.
    //Se cancela al cerrar el panel para no gastar CPU.

    const STORAGE_KEY_TAB = "jambotTabActivo";
    const TABS_VALIDOS = ["settings", "recoleccion", "construccion"];
    let tabActivo = window.localStorage.getItem(STORAGE_KEY_TAB) || "settings";
    if (!TABS_VALIDOS.includes(tabActivo)) tabActivo = "settings";
    //Estado de colapso del UI — vive en memoria nomás, no persiste.
    //  ciclos: { actual: bool, ultimo: bool }   true = expandido
    //  ciudades: { [id]: bool }                 true = expandido
    //  aldeas:   { [id]: bool }                 true = expandido (historial)
    const uiColapso = {
      ciclos: { actual: true, ultimo: true },
      ciudades: {},
      aldeas: {},
      errores: false,
    };

    function crearPanelConfig() {
      const panel = document.createElement("div");
      panel.id = "panelConfigJam";
      //Layout: ~70% del viewport en alto y ancho.
      //  - width: 70vw (cap 900px para no exagerar en monitores grandes,
      //    cap mín 460px para que las filas no se vean apretadas).
      //  - height: 70vh (con scroll interno si el contenido excede).
      //  - Posicionado bottom-left para quedar sobre la columna de botones
      //    sin tapar el centro del mapa.
      //  - z-index:5 deja los modales del juego por encima — clicks fuera
      //    del panel siguen llegando al juego.
      panel.style.cssText =
        //Centrado horizontal con left:50% + translate negativo. left:80px
        //antes pegaba el panel al borde izquierdo donde están los botones,
        //pero a 70vw quedaba feo. Ahora queda centrado sobre el mapa.
        //z-index:9999 — el PANEL va por encima de los modales del juego
        //(antes quedaba tapado por ventanas como el reporte de batalla).
        //Los BOTONES siguen en z-index:5 para no recibir clicks accidentales
        //de modales que se cierran encima de ellos (ver core.js).
        "position:absolute;bottom:110px;left:50%;transform:translateX(-50%);z-index:9999;" +
        "background:#1f2a36;color:#e6e9ee;padding:0;border:1px solid #2c3a4d;" +
        "border-radius:6px;display:none;" +
        "width:70vw;min-width:460px;max-width:900px;" +
        "height:70vh;max-height:calc(100vh - 140px);" +
        "overflow:hidden;" +  /* el scroll va en el body, no en el contenedor */
        "font-family:'Segoe UI',sans-serif;font-size:12px;line-height:1.45;" +
        "box-shadow:0 4px 16px rgba(0,0,0,0.5);" +
        "display:none;flex-direction:column";
      document.body.appendChild(panel);
      return panel;
    }

    //Handler para "click fuera" — registrado en document mientras el panel
    //está abierto. Lo extraigo a una variable para poder removerlo con
    //removeEventListener al cerrar (sin esto, los listeners se acumulan).
    const outsideClickHandler = (e) => {
      const panel = document.getElementById("panelConfigJam");
      if (!panel || panel.style.display === "none") return;
      //Click dentro del panel → no cerrar.
      if (panel.contains(e.target)) return;
      //Click sobre el botón ⚙ → no cerrar acá; el handler del botón se
      //encarga del toggle (sino quedaría abre/cierra/abre en el mismo click).
      const botonConfig = document.getElementById("botonConfigJam");
      if (botonConfig && botonConfig.contains(e.target)) return;
      cerrarPanel(panel);
    };

    function cerrarPanel(panel) {
      panel.style.display = "none";
      if (intervalActualizarPanel) {
        clearInterval(intervalActualizarPanel);
        intervalActualizarPanel = null;
      }
      document.removeEventListener("mousedown", outsideClickHandler, true);
    }

    function abrirPanel(panel) {
      //Display flex para que el flex-direction:column del cssText tome
      //efecto (header fijo arriba + body con scroll abajo).
      panel.style.display = "flex";
      renderPanelConfig(panel);
      intervalActualizarPanel = setInterval(() => {
        actualizarHeaderPanel(panel);
        //Re-render del body solo en tabs dinámicos: Recolección muestra
        //tiempos relativos / progreso en vivo, Construcción muestra
        //countdown de cada orden — ambos cambian cada segundo. Settings
        //es estático y no necesita repintar.
        const body = panel.querySelector(".pcj-body");
        if (!body) return;
        if (tabActivo === "recoleccion") renderTabRecoleccion(body);
        else if (tabActivo === "construccion") renderTabConstruccion(body);
      }, 1000);
      //Capture phase para correr antes que el click handler del botón ⚙
      //(que de todos modos nos retornamos antes en outsideClickHandler).
      document.addEventListener("mousedown", outsideClickHandler, true);
    }

    function togglePanelConfig(panel) {
      const visible = panel.style.display !== "none";
      if (visible) cerrarPanel(panel);
      else abrirPanel(panel);
    }

    function renderPanelConfig(panel) {
      panel.innerHTML = "";

      //Título + botón cerrar
      const titulo = document.createElement("div");
      titulo.className = "pcj-titulo";
      titulo.style.cssText =
        "font-weight:bold;font-size:14px;padding:8px 12px;" +
        "border-bottom:1px solid #2c3a4d;letter-spacing:0.5px;background:#172029;" +
        "display:flex;align-items:center;gap:8px";

      const tituloTxt = document.createElement("span");
      tituloTxt.textContent = "JamBot";
      tituloTxt.style.cssText = "flex:1;text-align:center";
      titulo.appendChild(tituloTxt);

      const cerrarBtn = document.createElement("button");
      cerrarBtn.textContent = "✕";
      cerrarBtn.title = "Cerrar (también podés hacer click fuera)";
      cerrarBtn.style.cssText =
        "background:transparent;color:#8a96a6;border:none;cursor:pointer;" +
        "font-size:16px;line-height:1;padding:0 4px;border-radius:3px";
      cerrarBtn.addEventListener("mouseenter", () => {
        cerrarBtn.style.color = "#e74c3c";
        cerrarBtn.style.background = "rgba(231,76,60,0.1)";
      });
      cerrarBtn.addEventListener("mouseleave", () => {
        cerrarBtn.style.color = "#8a96a6";
        cerrarBtn.style.background = "transparent";
      });
      cerrarBtn.addEventListener("click", () => cerrarPanel(panel));
      titulo.appendChild(cerrarBtn);

      panel.appendChild(titulo);

      //Header: estado + countdown
      const header = document.createElement("div");
      header.id = "panelHeaderEstado";
      header.style.cssText =
        "padding:8px 12px;border-bottom:1px solid #2c3a4d;font-size:11px;line-height:1.6;background:#1a232e";
      panel.appendChild(header);
      actualizarHeaderPanel(panel);

      //Tabs
      const tabs = document.createElement("div");
      tabs.className = "pcj-tabs";
      tabs.style.cssText =
        "display:flex;border-bottom:1px solid #2c3a4d;background:#172029";
      tabs.appendChild(crearBotonTab("settings", "Settings"));
      tabs.appendChild(crearBotonTab("recoleccion", "Recolección"));
      tabs.appendChild(crearBotonTab("construccion", "Construcción"));
      panel.appendChild(tabs);

      //Body del tab activo
      const body = document.createElement("div");
      body.className = "pcj-body";
      body.style.cssText = "padding:10px 12px";
      panel.appendChild(body);
      renderTabActivo(body);
    }

    function crearBotonTab(id, label) {
      const b = document.createElement("button");
      b.textContent = label;
      const activo = tabActivo === id;
      b.style.cssText =
        `flex:1;padding:8px 12px;background:${activo ? "#1f2a36" : "transparent"};` +
        `color:${activo ? "#3498db" : "#8a96a6"};border:none;border-bottom:2px solid ${activo ? "#3498db" : "transparent"};` +
        "cursor:pointer;font-weight:bold;font-size:12px;transition:all 0.15s";
      b.addEventListener("click", () => {
        tabActivo = id;
        window.localStorage.setItem(STORAGE_KEY_TAB, id);
        renderPanelConfig(document.getElementById("panelConfigJam"));
      });
      return b;
    }

    function renderTabActivo(body) {
      body.innerHTML = "";
      if (tabActivo === "settings") renderTabSettings(body);
      else if (tabActivo === "construccion") renderTabConstruccion(body);
      else renderTabRecoleccion(body);
    }

    function actualizarHeaderPanel(panel) {
      const header = panel.querySelector("#panelHeaderEstado");
      if (!header) return;

      let estadoTexto, estadoColor;
      if (core.isCaptchaActive()) {
        estadoTexto = "⚠ CAPTCHA";
        estadoColor = "#e74c3c";
      } else if (core.isPaused()) {
        estadoTexto = "▶ Pausado";
        estadoColor = "#27ae60";
      } else {
        estadoTexto = "⏸ Corriendo";
        estadoColor = "#3498db";
      }

      let proximoTexto = "—";
      if (cicloActual) {
        proximoTexto = `<span style="color:#f39c12">en curso (${cicloActual.ciudadesCompletadas}/${cicloActual.totalCiudades} ciudades · ${cicloActual.aldeasCompletadas}/${cicloActual.totalAldeas} aldeas)</span>`;
      } else if (proximoTickAt) {
        proximoTexto = core.formatDuracion((proximoTickAt - Date.now()) / 1000);
      }

      header.innerHTML =
        `<div><strong>Estado:</strong> <span style="color:${estadoColor}">${estadoTexto}</span></div>` +
        `<div><strong>Próximo ciclo:</strong> ${proximoTexto}</div>`;
    }

    //—— Tab Settings (configuración) ——————————————————————————————————————

    function renderTabSettings(body) {
      //Sección: features globales
      body.appendChild(crearTituloSeccion("Funciones"));
      body.appendChild(crearFilaToggleFinalizar());

      body.appendChild(crearSeparador());

      //Sección: tiempo por ciudad
      body.appendChild(crearTituloSeccion("Tiempo de recolección por ciudad"));

      if (!ciudadesConAldeas.length) {
        const vacio = document.createElement("div");
        vacio.textContent = "Cargando ciudades...";
        vacio.style.opacity = "0.7";
        body.appendChild(vacio);
        return;
      }

      const ciudadesOrden = ciudadesConAldeas.slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );
      for (const ciudad of ciudadesOrden) {
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        const fila = document.createElement("div");
        fila.style.cssText =
          "display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0";

        const nombre = document.createElement("span");
        nombre.textContent = ciudad.nombreCiudad || ciudad.codigoCiudad;
        nombre.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

        const select = document.createElement("select");
        select.style.cssText =
          "background:#0f1620;color:#e6e9ee;border:1px solid #2c3a4d;padding:3px 6px;border-radius:3px";
        const op5 = document.createElement("option");
        op5.value = "5"; op5.textContent = "5 min";
        const op10 = document.createElement("option");
        op10.value = "10"; op10.textContent = "10 min";
        select.appendChild(op5);
        select.appendChild(op10);
        select.value = String(cfg.minutos);

        select.addEventListener("change", async () => {
          const minutos = parseInt(select.value, 10);
          configPorCiudad[ciudad.codigoCiudad] = { minutos, opcion: 1 };
          await guardarConfigPorCiudad();
          core.log(
            "recoleccion",
            `config ${ciudad.nombreCiudad || ciudad.codigoCiudad}: ${minutos}min`,
            "ok"
          );
        });

        fila.appendChild(nombre);
        fila.appendChild(select);
        body.appendChild(fila);
      }

      //Sección: mantenimiento (acciones destructivas)
      body.appendChild(crearSeparador());
      body.appendChild(crearTituloSeccion("Mantenimiento"));
      body.appendChild(renderMantenimiento());
    }

    function renderMantenimiento() {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:4px";
      const mkBtn = (label, color, onClick) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText =
          `padding:5px 10px;background:#0f1620;color:${color};border:1px solid ${color};` +
          "border-radius:3px;cursor:pointer;font-size:10.5px";
        b.addEventListener("click", onClick);
        return b;
      };
      wrap.appendChild(mkBtn("Limpiar historial", "#e74c3c", () => {
        if (!confirm("¿Borrar todo el historial de claims y el último ciclo persistido?")) return;
        limpiarHistorial();
        renderTabActivo(document.querySelector("#panelConfigJam .pcj-body"));
      }));
      wrap.appendChild(mkBtn("Exportar JSON", "#3498db", () => exportarHistorial()));
      wrap.appendChild(mkBtn("Reset cooldown server", "#f39c12", () => {
        if (!confirm("¿Resetear el map de lastClaimAt? El próximo ciclo va a probar todas las aldeas y dejar que el server marque las que están en cooldown.")) return;
        limpiarLastClaimAt();
      }));
      return wrap;
    }

    function crearFilaToggleFinalizar() {
      const fila = document.createElement("div");
      fila.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0";

      const label = document.createElement("span");
      label.textContent = "Finalizar construcción gratis";
      label.style.cssText = "flex:1";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.style.cssText = "width:16px;height:16px;cursor:pointer";

      chrome.storage.local.get("jambotConfig", (obj) => {
        const cfg = obj && obj.jambotConfig;
        const enabled =
          cfg && typeof cfg.finalizarHabilitado === "boolean"
            ? cfg.finalizarHabilitado
            : data.finalizarGratis === true;
        check.checked = enabled;
      });

      check.addEventListener("change", () => {
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfgPrev = (obj && obj.jambotConfig) || {};
          const cfgNuevo = { ...cfgPrev, finalizarHabilitado: check.checked };
          chrome.storage.local.set({ jambotConfig: cfgNuevo }, () => {
            core.log("panel", `finalizar construcción ${check.checked ? "ON" : "OFF"}`, "ok");
          });
        });
      });

      fila.appendChild(label);
      fila.appendChild(check);
      return fila;
    }

    //—— Tab Recolección ——————————————————————————————————————————————————

    function renderTabRecoleccion(body) {
      body.innerHTML = "";

      //Sección 1: ciclo en curso (si lo hay) — colapsable, abierto por default
      if (cicloActual) {
        body.appendChild(seccionColapsable(
          `🍎  Ciclo #${cicloActual.n} en curso  ·  ${cicloActual.ciudadesCompletadas}/${cicloActual.totalCiudades} ciudades · ${cicloActual.aldeasCompletadas}/${cicloActual.totalAldeas} aldeas`,
          uiColapso.ciclos.actual,
          (v) => uiColapso.ciclos.actual = v,
          () => renderResumenCiclo(cicloActual, true),
          "#f39c12"
        ));
      }

      //Sección 2: último ciclo terminado
      if (ultimoCiclo) {
        const total = (ultimoCiclo.totalAldeas != null) ? ultimoCiclo.totalAldeas
          : Object.values(ultimoCiclo.ciudades || {}).reduce((s, c) => s + (c.esperado || 6), 0);
        const claims = Object.values(ultimoCiclo.ciudades || {}).reduce((s, c) => s + (c.claims || 0), 0);
        const completo = claims === total;
        body.appendChild(seccionColapsable(
          `${completo ? "✓" : "✗"}  Último ciclo #${ultimoCiclo.n}  ·  ${claims}/${total} aldeas  ·  ${formatHoraCorta(ultimoCiclo.fin)} (${core.formatDuracion((ultimoCiclo.duracion || 0) / 1000)})`,
          uiColapso.ciclos.ultimo,
          (v) => uiColapso.ciclos.ultimo = v,
          () => renderResumenCiclo(ultimoCiclo, false),
          completo ? "#27ae60" : "#e74c3c"
        ));
      }

      if (!cicloActual && !ultimoCiclo) {
        const vacio = document.createElement("div");
        vacio.textContent = "Todavía no se ejecutó ningún ciclo en esta sesión.";
        vacio.style.cssText = "opacity:0.7;padding:8px 0";
        body.appendChild(vacio);
      }

      //Sección 3: aldeas con historial — siempre visible (cada ciudad
      //colapsable, default cerradas excepto la que tiene aldeas falladas
      //en el último ciclo)
      body.appendChild(crearSeparador());
      body.appendChild(crearTituloSeccion("Aldeas e historial"));
      body.appendChild(renderListaCiudadesHistorial());

      //Sección 4: errores recientes
      body.appendChild(crearSeparador());
      const errores = core.getErrores ? core.getErrores().slice(-15).reverse() : [];
      body.appendChild(seccionColapsable(
        `⚠  Errores y warnings recientes  (${errores.length})`,
        uiColapso.errores,
        (v) => uiColapso.errores = v,
        () => renderErrores(errores),
        errores.length ? "#f39c12" : "#8a96a6"
      ));
    }

    //—— Tab Construcción ——————————————————————————————————————————————————

    function renderTabConstruccion(body) {
      body.innerHTML = "";
      const ds = data.construccion;
      if (!ds) {
        const v = document.createElement("div");
        v.textContent = "La feature de construcción todavía no está cargada.";
        v.style.cssText = "opacity:0.7;padding:8px 0";
        body.appendChild(v);
        return;
      }

      //Header de estado de la feature
      const estadoFila = document.createElement("div");
      estadoFila.style.cssText =
        "display:flex;justify-content:space-between;gap:10px;padding:6px 8px;background:#172029;border-radius:3px;margin-bottom:8px;font-size:11px";
      const estadoColor = !ds.habilitada ? "#8a96a6" : (core.isPaused() ? "#27ae60" : "#3498db");
      const estadoTxt = !ds.habilitada ? "Deshabilitada (activar en Settings)"
        : core.isPaused() ? "Pausada (bot global pausado)"
        : "Activa";
      let proximoTxt = "—";
      if (ds.proximoTickAt) {
        const seg = Math.max(0, Math.round((ds.proximoTickAt - Date.now()) / 1000));
        proximoTxt = core.formatDuracion(seg);
      }
      estadoFila.innerHTML =
        `<span><strong>Estado:</strong> <span style="color:${estadoColor}">${estadoTxt}</span></span>` +
        `<span><strong>Próximo tick:</strong> ${proximoTxt}</span>`;
      body.appendChild(estadoFila);

      //Sección 1: último ciclo
      if (ds.ultimoCiclo) {
        const u = ds.ultimoCiclo;
        const completo = u.finalizadas === u.ordenesEnVentana;
        body.appendChild(seccionColapsable(
          `${completo ? "✓" : "·"}  Último ciclo  ·  ${u.finalizadas}/${u.ordenesEnVentana} finalizadas  ·  ${u.ordenesEnCola} en cola  ·  ${formatHoraCorta(u.fin)} (${core.formatDuracion((u.duracion || 0) / 1000)})`,
          true,
          () => {},
          () => renderResumenCicloConstr(u),
          completo ? "#27ae60" : (u.ordenesEnVentana === 0 ? "#8a96a6" : "#f39c12")
        ));
      }

      //Sección 2: cola actual (todas las órdenes pendientes, ordenadas por
      //tiempo restante)
      const cola = (ds.ultimaCola || []).slice();
      body.appendChild(seccionColapsable(
        `🏗️  Cola actual  (${cola.length})`,
        true,
        () => {},
        () => renderColaConstr(cola),
        cola.some((o) => o.enVentana) ? "#f39c12" : "#3498db"
      ));

      //Sección 3: últimas finalizadas
      const finalizadas = (ds.finalizadas || []).slice().reverse();
      body.appendChild(seccionColapsable(
        `✓  Últimas finalizadas  (${finalizadas.length})`,
        true,
        () => {},
        () => renderFinalizadasConstr(finalizadas),
        "#27ae60"
      ));

      //Sección 4: errores recientes filtrados por scope=finalizar
      body.appendChild(crearSeparador());
      const errores = core.getErrores
        ? core.getErrores({ scope: "finalizar" }).slice(-15).reverse()
        : [];
      body.appendChild(seccionColapsable(
        `⚠  Errores y warnings de finalizar  (${errores.length})`,
        false,
        () => {},
        () => renderErrores(errores),
        errores.length ? "#f39c12" : "#8a96a6"
      ));
    }

    function renderResumenCicloConstr(u) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "font-family:monospace;font-size:11px;line-height:1.6";
      const linea = (label, val, color) => {
        const d = document.createElement("div");
        d.innerHTML = `<span style="color:#8a96a6;display:inline-block;width:160px">${label}</span>` +
          `<span style="color:${color || "#cdd5e0"}">${val}</span>`;
        return d;
      };
      wrap.appendChild(linea("Órdenes en cola:", u.ordenesEnCola));
      wrap.appendChild(linea("En ventana free:", u.ordenesEnVentana, u.ordenesEnVentana ? "#f39c12" : "#cdd5e0"));
      wrap.appendChild(linea("Finalizadas:", u.finalizadas, u.finalizadas ? "#27ae60" : "#cdd5e0"));
      wrap.appendChild(linea("Duración:", core.formatDuracion((u.duracion || 0) / 1000)));
      if (u.captchaDurante) {
        wrap.appendChild(linea("CAPTCHA:", "sí", "#e74c3c"));
      }
      return wrap;
    }

    function renderColaConstr(cola) {
      const wrap = document.createElement("div");
      if (!cola.length) {
        const v = document.createElement("div");
        v.textContent = "(no hay órdenes en cola)";
        v.style.cssText = "opacity:0.6;font-style:italic;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const tabla = document.createElement("div");
      tabla.style.cssText = "font-family:monospace;font-size:10.5px";
      const ahora = Math.floor(Date.now() / 1000);
      for (const o of cola) {
        const restante = Math.max(0, o.finish_time - ahora);
        const enVentana = restante <= VENTANA_SEGUNDOS_DEFAULT;
        const c = enVentana ? "#f39c12" : "#cdd5e0";
        const fila = document.createElement("div");
        fila.style.cssText =
          "display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #1a232e";
        fila.innerHTML =
          `<span style="color:${c};min-width:14px">${enVentana ? "⏱" : "·"}</span>` +
          `<span style="flex:1;color:#cdd5e0">${escapeHtml(o.town_nombre)}</span>` +
          `<span style="flex:1;color:#8a96a6">${escapeHtml(o.building_type)}</span>` +
          `<span style="color:${c};min-width:75px;text-align:right">${core.formatDuracion(restante)}</span>`;
        tabla.appendChild(fila);
      }
      wrap.appendChild(tabla);
      return wrap;
    }

    function renderFinalizadasConstr(finalizadas) {
      const wrap = document.createElement("div");
      if (!finalizadas.length) {
        const v = document.createElement("div");
        v.textContent = "(todavía no se finalizó ninguna en esta sesión)";
        v.style.cssText = "opacity:0.6;font-style:italic;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const tabla = document.createElement("div");
      tabla.style.cssText = "font-family:monospace;font-size:10.5px";
      for (const f of finalizadas) {
        const fila = document.createElement("div");
        fila.style.cssText =
          "display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #1a232e";
        fila.innerHTML =
          `<span style="color:#8a96a6;min-width:42px">${formatHoraCorta(f.ts)}</span>` +
          `<span style="color:#27ae60;min-width:12px">✓</span>` +
          `<span style="flex:1;color:#cdd5e0">${escapeHtml(f.town_nombre || f.town_id)}</span>` +
          `<span style="flex:1;color:#8a96a6">${escapeHtml(f.building_type)}</span>` +
          `<span style="color:#5a6776">id ${f.id}</span>`;
        tabla.appendChild(fila);
      }
      return wrap;
    }

    //Constante local para el tab Construcción — duplica VENTANA_SEGUNDOS de
    //finalizarConstruccion (290s = "free finish" del juego). No la
    //importamos vía data porque la feature podría no haber arrancado
    //todavía cuando se renderiza el panel.
    const VENTANA_SEGUNDOS_DEFAULT = 290;

    //—— Componentes reutilizables ————————————————————————————————————————

    function crearTituloSeccion(texto) {
      const t = document.createElement("div");
      t.textContent = texto;
      t.style.cssText = "font-weight:bold;margin:8px 0 6px;color:#cdd5e0";
      return t;
    }

    function crearSeparador() {
      const s = document.createElement("div");
      s.style.cssText = "border-top:1px solid #2c3a4d;margin:10px 0";
      return s;
    }

    /**
     * Sección con header clickeable que colapsa/expande el contenido. El
     * contenido se construye lazy (callback `renderContenido`) — solo se
     * llama cuando está expandido. Persiste el estado vía `setExpandido`.
     */
    function seccionColapsable(headerTexto, expandido, setExpandido, renderContenido, colorAcento) {
      const cont = document.createElement("div");
      cont.style.cssText = "margin:6px 0";

      const header = document.createElement("div");
      header.style.cssText =
        "display:flex;align-items:center;cursor:pointer;padding:6px 8px;" +
        `background:#172029;border-left:3px solid ${colorAcento || "#3498db"};border-radius:3px;` +
        "user-select:none;font-size:11.5px";
      const arrow = document.createElement("span");
      arrow.textContent = expandido ? "▼" : "▶";
      arrow.style.cssText = "margin-right:6px;color:#8a96a6;font-size:9px;width:10px";
      const txt = document.createElement("span");
      txt.innerHTML = headerTexto;
      txt.style.cssText = "flex:1";
      header.appendChild(arrow);
      header.appendChild(txt);
      cont.appendChild(header);

      const contenido = document.createElement("div");
      contenido.style.cssText = "padding:6px 8px 0 18px";
      contenido.style.display = expandido ? "block" : "none";
      if (expandido) contenido.appendChild(renderContenido());
      cont.appendChild(contenido);

      header.addEventListener("click", () => {
        const ahora = contenido.style.display === "none";
        setExpandido(ahora);
        contenido.style.display = ahora ? "block" : "none";
        arrow.textContent = ahora ? "▼" : "▶";
        if (ahora && contenido.childElementCount === 0) {
          contenido.appendChild(renderContenido());
        }
      });

      return cont;
    }

    function renderResumenCiclo(ciclo, enCurso) {
      const wrap = document.createElement("div");
      const ciudadesArr = Object.entries(ciclo.ciudades || {})
        .map(([id, c]) => ({ id, ...c }))
        .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", undefined, { numeric: true }));
      for (const c of ciudadesArr) {
        const fila = document.createElement("div");
        const completa = c.claims >= (c.esperado || 6);
        const color = enCurso && c.claims === 0 ? "#8a96a6" : completa ? "#27ae60" : "#e74c3c";
        const icon = enCurso && c.claims === 0 ? "·" : completa ? "✓" : "✗";
        fila.style.cssText =
          "display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-family:monospace;font-size:11px";
        fila.innerHTML =
          `<span style="color:${color};min-width:10px">${icon}</span>` +
          `<span style="flex:1">${escapeHtml(c.nombre)}</span>` +
          `<span style="color:#cdd5e0">${c.claims}/${c.esperado || 6}</span>` +
          `<span style="color:#8a96a6;min-width:140px;text-align:right">+${c.wood}/+${c.stone}/+${c.iron}</span>`;
        wrap.appendChild(fila);
      }
      if (!enCurso && ciclo.duracion != null) {
        const totWood = ciudadesArr.reduce((s, c) => s + (c.wood || 0), 0);
        const totStone = ciudadesArr.reduce((s, c) => s + (c.stone || 0), 0);
        const totIron = ciudadesArr.reduce((s, c) => s + (c.iron || 0), 0);
        const totales = document.createElement("div");
        totales.style.cssText =
          "margin-top:6px;padding-top:6px;border-top:1px dashed #2c3a4d;font-family:monospace;font-size:11px;color:#cdd5e0";
        totales.innerHTML =
          `<span style="color:#8a96a6">total ciclo:</span> +${totWood} mad / +${totStone} pie / +${totIron} pla`;
        wrap.appendChild(totales);
      }
      return wrap;
    }

    function renderListaCiudadesHistorial() {
      const wrap = document.createElement("div");
      const ciudadesOrden = ciudadesConAldeas.slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );
      for (const ciudad of ciudadesOrden) {
        const aldeasOrden = (ciudad.aldeas || []).slice().sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", undefined, { numeric: true })
        );
        const okEnUltimoCiclo = ultimoCiclo && ultimoCiclo.ciudades && ultimoCiclo.ciudades[ciudad.codigoCiudad];
        const claims = okEnUltimoCiclo ? okEnUltimoCiclo.claims : 0;
        const esperado = okEnUltimoCiclo ? okEnUltimoCiclo.esperado : 6;
        const color = !okEnUltimoCiclo ? "#8a96a6"
          : claims >= esperado ? "#27ae60" : "#e74c3c";
        const headerTxt = `${escapeHtml(ciudad.nombreCiudad || ciudad.codigoCiudad)} · ${aldeasOrden.length} aldeas` +
          (okEnUltimoCiclo ? ` · último: ${claims}/${esperado}` : "");
        const expandidoDefault = uiColapso.ciudades[ciudad.codigoCiudad] === true ||
          (ultimoCiclo && claims < esperado && uiColapso.ciudades[ciudad.codigoCiudad] !== false);
        wrap.appendChild(seccionColapsable(
          headerTxt,
          !!expandidoDefault,
          (v) => uiColapso.ciudades[ciudad.codigoCiudad] = v,
          () => renderAldeasDeCiudad(aldeasOrden),
          color
        ));
      }
      return wrap;
    }

    function renderAldeasDeCiudad(aldeas) {
      const wrap = document.createElement("div");
      for (const aldea of aldeas) {
        const histo = historialPorAldea[aldea.id] || [];
        const ultimaOk = [...histo].reverse().find((e) => e.status === "ok");
        const desde = ultimaOk ? formatRelativo(ultimaOk.ts) : "—";
        const ultimaCualquiera = histo[histo.length - 1];
        const statusColor = !ultimaCualquiera ? "#8a96a6"
          : ultimaCualquiera.status === "ok" ? "#27ae60"
          : ultimaCualquiera.status === "saltada-cooldown" ? "#8a96a6"
          : "#e74c3c";
        const statusTxt = !ultimaCualquiera ? "—" : ultimaCualquiera.status;
        const headerTxt = `${escapeHtml(aldea.name || `id ${aldea.id}`)}  ·  hace ${desde}  ·  ${statusTxt}`;
        wrap.appendChild(seccionColapsable(
          headerTxt,
          uiColapso.aldeas[aldea.id] === true,
          (v) => uiColapso.aldeas[aldea.id] = v,
          () => renderHistorialAldea(aldea),
          statusColor
        ));
      }
      return wrap;
    }

    function renderHistorialAldea(aldea) {
      const wrap = document.createElement("div");
      const histo = (historialPorAldea[aldea.id] || []).slice().reverse();
      if (!histo.length) {
        const v = document.createElement("div");
        v.textContent = "(sin historial todavía — esperá al primer claim)";
        v.style.cssText = "opacity:0.6;font-style:italic;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const tabla = document.createElement("div");
      tabla.style.cssText = "font-family:monospace;font-size:10.5px";
      for (const e of histo) {
        const fila = document.createElement("div");
        fila.style.cssText =
          "display:flex;gap:8px;padding:2px 0;border-bottom:1px solid #1a232e";
        const c =
          e.status === "ok" ? "#27ae60" :
          e.status === "saltada-cooldown" ? "#8a96a6" :
          e.status === "reintentar" ? "#f39c12" : "#e74c3c";
        const cuerpo =
          e.status === "ok" && e.dW != null
            ? `${fmt(e.dW)}/${fmt(e.dS)}/${fmt(e.dI)}`
            : e.status === "saltada-cooldown"
            ? `cooldown ${e.esperaSeg ? core.formatDuracion(e.esperaSeg) : ""}`.trim()
            : e.errorMsg || e.status;
        fila.innerHTML =
          `<span style="color:#8a96a6;min-width:42px">${formatHoraCorta(e.ts)}</span>` +
          `<span style="color:${c};min-width:12px">${e.status === "ok" ? "✓" : e.status === "saltada-cooldown" ? "·" : "✗"}</span>` +
          `<span style="flex:1;color:${c}">${escapeHtml(cuerpo)}</span>` +
          `<span style="color:#5a6776">#${e.ciclo || "?"}</span>`;
        tabla.appendChild(fila);
      }
      wrap.appendChild(tabla);
      return wrap;
    }

    function renderErrores(errores) {
      const wrap = document.createElement("div");
      if (!errores.length) {
        const v = document.createElement("div");
        v.textContent = "Sin errores ni warnings registrados.";
        v.style.cssText = "opacity:0.6;font-style:italic;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      for (const e of errores) {
        const fila = document.createElement("div");
        const c = e.nivel === "error" ? "#e74c3c" : "#f39c12";
        fila.style.cssText =
          "display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #1a232e;font-family:monospace;font-size:10.5px";
        fila.innerHTML =
          `<span style="color:#8a96a6;min-width:42px">${formatHoraCorta(e.ts)}</span>` +
          `<span style="color:${c};min-width:50px">[${escapeHtml(e.scope)}]</span>` +
          `<span style="flex:1;color:#cdd5e0">${escapeHtml(e.mensaje)}</span>`;
        wrap.appendChild(fila);
      }
      const limpiar = document.createElement("button");
      limpiar.textContent = "Limpiar buffer";
      limpiar.style.cssText =
        "margin-top:8px;padding:4px 10px;background:#0f1620;color:#cdd5e0;" +
        "border:1px solid #2c3a4d;border-radius:3px;cursor:pointer;font-size:10.5px";
      limpiar.addEventListener("click", () => {
        if (core.clearErrores) core.clearErrores();
        renderTabActivo(document.querySelector("#panelConfigJam .pcj-body"));
      });
      wrap.appendChild(limpiar);
      return wrap;
    }

    //—— Helpers de formato ————————————————————————————————————————————————

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function formatHoraCorta(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function formatRelativo(ts) {
      if (!ts) return "—";
      const seg = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (seg < 60) return `${seg}s`;
      const min = Math.floor(seg / 60);
      if (min < 60) return `${min}m`;
      const h = Math.floor(min / 60);
      const m = min % 60;
      return `${h}h ${m}m`;
    }

    function pintarEstadoBoton(estado) {
      switch (estado) {
        case "pausado":
          boton.setLabel("▶");
          boton.setStyle({ bg: "#27ae60", fg: "#fff" });
          break;
        case "corriendo":
          boton.setLabel("⏸");
          boton.setStyle({ bg: "#3498db", fg: "#fff" });
          break;
        case "captcha":
          boton.setLabel("⚠");
          boton.setStyle({ bg: "#c0392b", fg: "#fff" });
          break;
      }
    }

    //Reflejar cambios de CAPTCHA en el botón. Cuando se resuelve, volver
    //al estado anterior según core.isPaused().
    core.onCaptcha((active) => {
      if (active) pintarEstadoBoton("captcha");
      else pintarEstadoBoton(core.isPaused() ? "pausado" : "corriendo");
    });

    //—— Bridge: pedir recursos actuales del Town cargado en MM ———————————

    function queryTownResources(townId) {
      return new Promise((resolve) => {
        const handler = (e) => {
          if (e.source !== window) return;
          const msg = e.data;
          if (!msg || msg.type !== "JamBot:townResources") return;
          if (msg.townId != townId) return;
          window.removeEventListener("message", handler);
          clearTimeout(timeoutId);
          resolve(msg.resources || null);
        };
        window.addEventListener("message", handler);
        const timeoutId = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 1000);
        window.dispatchEvent(
          new CustomEvent("JamBot:queryTownResources", { detail: { townId } })
        );
      });
    }

    //—— Scheduler ———————————————————————————————————————————————————————

    //Watchdog: handle del setTimeout que vigila si el ciclo se colgó. Se
    //arma cada vez que programamos un tick y se cancela cuando el tick
    //efectivamente arranca o cuando el siguiente programarSiguienteTick lo
    //sobrescribe.
    let watchdogId = null;

    function programarSiguienteTick(ms) {
      if (proximoTickId) clearTimeout(proximoTickId);
      if (watchdogId) clearTimeout(watchdogId);
      proximoTickAt = Date.now() + ms;
      proximoTickId = setTimeout(async () => {
        proximoTickId = null;
        proximoTickAt = null;
        await recolectarRecursos();
      }, ms);

      //Watchdog: si pasaron 2× del tiempo esperado + 60s y el siguiente
      //tick nunca arrancó (proximoTickId sigue null y no estamos pausados),
      //el ciclo se colgó por algo no manejado (fetch que ni siquiera abortó,
      //unhandled rejection, etc). Relanzamos para no quedar mudos.
      const margenWatchdogMs = ms * 2 + 60_000;
      watchdogId = setTimeout(() => {
        watchdogId = null;
        if (core.isPaused()) return;
        if (proximoTickId == null && proximoTickAt == null) {
          core.logWarn(
            "recoleccion",
            `watchdog: el ciclo no arrancó después de ${core.formatDuracion(margenWatchdogMs / 1000)} — relanzando`
          );
          recolectarRecursos();
        }
      }, margenWatchdogMs);
    }

    async function recolectarRecursos() {
      if (core.isPaused()) return;
      pintarEstadoBoton(core.isCaptchaActive() ? "captcha" : "corriendo");

      nCiclo += 1;
      const inicioCiclo = Date.now();

      //Inicializar cicloActual con el esqueleto de las ciudades. Se popula
      //a medida que cada ciudad/aldea se procesa, y al final se promueve a
      //ultimoCiclo. El indicador en tiempo real (bajo el botón) lee este
      //estado para mostrar progreso durante el ciclo.
      const ciudadesIniciales = {};
      for (const c of ciudadesConAldeas) {
        ciudadesIniciales[c.codigoCiudad] = {
          nombre: c.nombreCiudad || c.codigoCiudad,
          claims: 0,
          esperado: 6,
          wood: 0, stone: 0, iron: 0,
          aldeasFalladas: [],
        };
      }
      cicloActual = {
        n: nCiclo,
        inicio: inicioCiclo,
        fin: null,
        duracion: null,
        captchaDurante: false,
        ciudades: ciudadesIniciales,
        totalCiudades: ciudadesConAldeas.length,
        ciudadesCompletadas: 0,
        totalAldeas: ciudadesConAldeas.length * 6,
        aldeasCompletadas: 0,
      };
      actualizarIndicadorVivo();

      const stats = await recolectarCiudades();
      const duracionCiclo = Date.now() - inicioCiclo;

      //Promover cicloActual → ultimoCiclo y persistir.
      if (cicloActual) {
        cicloActual.fin = Date.now();
        cicloActual.duracion = duracionCiclo;
        cicloActual.captchaDurante = core.isCaptchaActive();
        ultimoCiclo = cicloActual;
        cicloActual = null;
        guardarHistorial();
        actualizarIndicadorVivo();
      }

      //Si el usuario pausó durante el ciclo, no programamos el siguiente.
      if (core.isPaused()) return;

      //Compensación de duración del ciclo: el siguiente tick se programa
      //para que el INICIO del ciclo siguiente caiga (en promedio) a
      //tiempoCicloMinutos del inicio del actual, no de su fin. Sin esto,
      //cada vuelta acumula `duracionCiclo` como gap permanente vs el
      //cooldown del server (5/10min reales).
      //
      //Base = mínimo de tiempos configurados (5 o 10). Si todas las
      //ciudades están en 10min, el ciclo tickea cada 10 — no nos
      //despertamos cada 5min para no hacer nada.
      //
      //Margen de seguridad +3-30s: el server libera el cooldown EXACTAMENTE
      //a los 5 o 10min desde el último claim de cada aldea. Si el ciclo se
      //solapa demasiado (peor caso: aldea procesada al final del ciclo N
      //y al principio del N+1), el server rechaza el claim y el bot lo
      //interpreta como CAPTCHA falso. El margen mínimo de 3s cubre eso.
      const baseMs = tiempoCicloMinutos() * 60 * 1000;
      let tiempoEspera;
      if (core.isCaptchaActive()) {
        tiempoEspera = 30 * 1000;
      } else {
        //Espera estándar: el próximo ciclo arranca al MISMO instante que
        //el actual + baseMs (compensa duracionCiclo + jitter anti-bot).
        const esperaNormal = baseMs - duracionCiclo + jitter(3 * 1000, 30 * 1000);
        let esperaAjustada = esperaNormal;
        //Si en este ciclo hubo aldeas saltadas por cooldown y la próxima
        //se libera ANTES del próximo tick normal (típicamente porque el
        //ciclo arrancó tras un reload con cooldown a medias), adelantamos
        //el siguiente tick para no perder yield. +5s coincide con el
        //margen que usa cooldownMs (Fase 2) — pegamos al server justo
        //después de que libera.
        if (stats && isFinite(stats.proximaLiberacionSeg)) {
          const esperaServer = stats.proximaLiberacionSeg * 1000 + 5_000;
          if (esperaServer < esperaAjustada) {
            core.log(
              "recoleccion",
              `próxima aldea libre en ${core.formatDuracion(stats.proximaLiberacionSeg)} — adelantando próximo ciclo (en vez de esperar ${core.formatDuracion(esperaNormal / 1000)})`,
              "ok"
            );
            esperaAjustada = esperaServer;
          }
        }
        //Piso 30s: si la próxima aldea está libre en <30s no tickeamos
        //inmediato — damos margen para que el server termine de procesar
        //el último claim y para no spammear si hay timing extraño.
        tiempoEspera = Math.max(30 * 1000, esperaAjustada);
      }

      core.log(
        "recoleccion",
        `ciclo #${nCiclo} OK · duró ${core.formatDuracion(duracionCiclo / 1000)} · próximo en ${core.formatDuracion(tiempoEspera / 1000)}${core.isCaptchaActive() ? " (modo CAPTCHA)" : ""}`,
        "ok"
      );

      //Warning si el ciclo se está acercando al cooldown — a partir del 70%
      //hay riesgo de chocar con el cooldown del server cuando una ciudad
      //procesada al final del ciclo aparezca al principio del siguiente.
      //La solución es subir esas ciudades a 10min en el panel.
      if (duracionCiclo > baseMs * 0.7) {
        const pct = Math.round((duracionCiclo / baseMs) * 100);
        core.logWarn(
          "recoleccion",
          `ciclo (${core.formatDuracion(duracionCiclo / 1000)}) ocupa el ${pct}% del cooldown (${core.formatDuracion(baseMs / 1000)}). Riesgo de rechazo del server — subí ciudades a 10min.`
        );
      }

      pintarEstadoBoton(core.isCaptchaActive() ? "captcha" : "corriendo");
      programarSiguienteTick(tiempoEspera);
    }

    //—— Lógica de recolección ——————————————————————————————————————————

    async function recolectarCiudades() {
      core.logCiclo("recoleccion", `CICLO #${nCiclo}`);

      //Reset por ciclo: si en un ciclo previo se cacheó "recursos llenos",
      //volvemos a intentar — quizá el jugador construyó cosas y bajaron.
      for (const c of ciudadesConAldeas) c.recursosLlenos = false;

      //Refresca el baseline del diff con el estado actual del Town en MM.
      //Sin esto, el primer claim del ciclo arrastra los 5 minutos transcurridos
      //(producción + acciones del jugador) y el diff sale absurdo.
      for (const c of ciudadesConAldeas) {
        const fresco = await queryTownResources(c.codigoCiudad);
        if (fresco) recursosPrevPorCiudad[c.codigoCiudad] = fresco;
      }

      const acumuladoCiclo = {};

      //Importante: NO hacer early-skip aquí aunque captcha esté activo.
      //Necesitamos hacer al menos un claim de "probe" para detectar si el
      //CAPTCHA ya se resolvió. La detección post-claim cortará el ciclo si
      //sigue activo.
      //
      //Orden de ciudades: alfabético-natural por nombre (001 Jam < 002 Jam
      //< 010 Jam). Predictible para debugging. La huella anti-bot la sigue
      //dando el shuffle de ALDEAS dentro de cada ciudad.
      //
      //El cooldown gating se hace por ALDEA dentro de recolectarCiudad.
      //Antes era por ciudad y eso perdía aldeas cuando el CAPTCHA cortaba
      //un ciclo a mitad: la ciudad quedaba marcada como "ya procesada"
      //aunque le faltaran aldeas. Ahora cada aldea respeta su propio
      //cooldown server, así que las pendientes se retoman en el próximo
      //ciclo sin esperar 10min.
      const ciudadesOrdenadas = ciudadesConAldeas.slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );
      //cicloState.proximaLiberacionSeg agrega el mínimo de "cuándo se libera
      //la próxima aldea" entre TODAS las ciudades. Se actualiza desde
      //recolectarCiudad cuando hay aldeas saltadas por cooldown. Lo usamos
      //al final para reprogramar el próximo tick si es antes del intervalo
      //normal — evita perder yield después de un reload.
      const cicloState = { probeCaptchaUsado: false, proximaLiberacionSeg: Infinity };
      //Lista de aldeas para reintentar al final del ciclo. Se popula en
      //recolectarCiudad cuando el server rechaza (success:false) o el fetch
      //tira un error transitorio (timeout, abort, network).
      const pendientes = [];
      for (const ciudad of ciudadesOrdenadas) {
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        acumuladoCiclo[ciudad.codigoCiudad] = { wood: 0, stone: 0, iron: 0, claims: 0 };
        //Banner azul por ciudad — mismo formato que el banner de ciclo pero
        //en color "info" para distinguirlo visualmente de los headers de
        //ciclo (violeta).
        core.logCiclo(
          "recoleccion",
          ciudad.nombreCiudad || ciudad.codigoCiudad,
          "info"
        );
        await recolectarCiudad(
          ciudad,
          acumuladoCiclo[ciudad.codigoCiudad],
          cfg.opcion,
          cfg.minutos,
          cicloState,
          pendientes
        );
        if (core.isCaptchaActive()) {
          core.logWarn("recoleccion", "CAPTCHA activo — abortando ciclo");
          break;
        }
      }

      //Retry diferido — máx 3 intentos por aldea (1 inicial + 2 reintentos),
      //con espera de 5s entre rondas. Esa pausa le da aire al server (la
      //mayoría de success:false son por cooldown casi vencido o rate limit
      //transitorio) y reduce la chance de pegarle de nuevo justo cuando
      //todavía no liberó.
      const MAX_INTENTOS = 3;
      const ESPERA_RONDA_MS = 5000;
      let pendientesActuales = pendientes;
      while (pendientesActuales.length > 0 && !core.isCaptchaActive() && !core.isPaused()) {
        const ronda = pendientesActuales;
        pendientesActuales = [];
        core.log(
          "recoleccion",
          `retry: reintentando ${ronda.length} aldea(s) que fallaron en este ciclo`,
          "warn"
        );
        await delayMs(ESPERA_RONDA_MS);

        for (const item of ronda) {
          if (core.isCaptchaActive() || core.isPaused()) break;
          if (item.intentos >= MAX_INTENTOS) {
            core.logError(
              "recoleccion",
              `aldea ${item.aldea.id} (${item.ciudad.nombreCiudad || item.ciudad.codigoCiudad}): descartada tras ${MAX_INTENTOS} intentos sin éxito`
            );
            continue;
          }
          try {
            const r = await recolectarAldea(item.ciudad, item.aldea, item.acumulador, item.opcion);
            if (r.status === "ok") {
              lastClaimAtPorAldea[item.aldea.id] = Date.now();
              guardarLastClaimAt();
            } else if (r.status === "reintentar") {
              pendientesActuales.push({ ...item, intentos: item.intentos + 1 });
            }
            //status === 'descartar' → no reintentamos
          } catch (e) {
            core.logError(
              "recoleccion",
              `retry falló aldea id=${item.aldea.id} (${item.ciudad.nombreCiudad || item.ciudad.codigoCiudad})`,
              e
            );
            pendientesActuales.push({ ...item, intentos: item.intentos + 1 });
          }
        }
      }

      //Resumen por ciudad (solo las que tuvieron al menos un claim contado).
      //Recorremos en el mismo orden alfabético del procesamiento para que
      //el bloque de tandas matchee visualmente con los claims de arriba.
      //
      //Tanda completa → log verde estándar.
      //Tanda incompleta → logError (rojo destacado + entra al buffer
      //`JamBot.errores()`), porque cualquier aldea no farmeada es yield
      //perdido y vale la pena resaltarlo como falla.
      //Total esperado de aldeas por ciudad: SIEMPRE 6 en Grepolis (regla
      //del juego, no de la cuenta). Lo que crece con el tiempo es el número
      //de ciudades del jugador, no las aldeas por ciudad. Si una tanda
      //reporta menos de 6, hubo un rechazo del server, un cooldown
      //desfasado, o un CAPTCHA mid-ciclo — y queremos que se vea como error.
      const TOTAL_ESPERADO = 6;
      for (const ciudad of ciudadesOrdenadas) {
        const acc = acumuladoCiclo[ciudad.codigoCiudad];
        if (!acc || acc.claims === 0) continue;
        const nombre = ciudad.nombreCiudad || ciudad.codigoCiudad;
        const resumen = `${nombre}: ${acc.claims}/${TOTAL_ESPERADO} aldeas → ${fmt(acc.wood)}/${fmt(acc.stone)}/${fmt(acc.iron)}`;
        if (acc.claims === TOTAL_ESPERADO) {
          core.log("recoleccion", `─── ${resumen} ───`, "ok");
        } else {
          core.logError(
            "recoleccion",
            `tanda incompleta — ${resumen} (faltaron ${TOTAL_ESPERADO - acc.claims})`
          );
        }
      }

      //Devolver stats agregadas que recolectarRecursos usa para programar
      //el próximo tick (concretamente, proximaLiberacionSeg para evitar
      //esperar el cooldown completo cuando hay aldeas listas en menos —
      //típico después de un reload).
      return { proximaLiberacionSeg: cicloState.proximaLiberacionSeg };
    }

    //Formatea un delta con signo explícito (+102, -34). Sin esto, los gastos
    //del jugador entre claims salían como "+-898" — confuso. Helper local
    //porque solo se usa en los dos sitios de log de claim/tanda.
    function fmt(n) {
      return n >= 0 ? `+${n}` : `${n}`;
    }

    async function recolectarCiudad(ciudad, acumulador, opcion, minutos, cicloState, pendientes) {
      const { aldeas } = ciudad;
      //Margen de +5s sobre el cooldown server real (5 o 10min). Antes
      //restábamos 30s "para no saltar una aldea casi vencida", pero el
      //efecto era el opuesto: el bot pegaba al server antes de que liberara
      //el cooldown y comía un success:false silencioso (perdía el claim
      //hasta el siguiente ciclo). Sumar 5s cubre drift de reloj
      //cliente/server, latencia de red y jitter del setTimeout. Costo: ~1.7%
      //de yield en ciudades de 5min, ~0.8% en las de 10min — despreciable.
      const cooldownMs = minutos * 60 * 1000 + 5 * 1000;

      let saltadasPorCooldown = 0;
      let restanteMinSeg = Infinity;

      //Shuffle del orden de aldeas — mismo argumento que ciudades: rompe el
      //patrón "siempre claim 1, después 2, después 3…".
      for (const aldea of shuffle(aldeas)) {
        const last = lastClaimAtPorAldea[aldea.id] || 0;
        const transcurrido = Date.now() - last;

        //Sincronización con server al primer ciclo: si todavía no claimeamos
        //esta aldea en esta sesión (last == 0), respetamos el campo
        //`aldea.loot` que el server nos dio en obtenerCiudadesConAldeas.
        //Es un timestamp Unix en segundos del próximo claim disponible.
        //Sin esto, después de un reload el bot intenta todas las aldeas
        //asumiendo cooldown=0 y el server las rechaza con success:false.
        if (last === 0 && aldea.loot) {
          const ahoraSec = Math.floor(Date.now() / 1000);
          if (aldea.loot > ahoraSec) {
            saltadasPorCooldown += 1;
            const restante = aldea.loot - ahoraSec;
            if (restante < restanteMinSeg) restanteMinSeg = restante;
            registrarClaim({
              aldeaId: aldea.id, ciudadId: ciudad.codigoCiudad,
              ciudadNombre: ciudad.nombreCiudad || ciudad.codigoCiudad,
              aldeaNombre: aldea.name || `farm_${aldea.id}`,
              ciclo: nCiclo, status: "saltada-cooldown",
              esperaSeg: restante,
            });
            continue;
          }
        }

        if (last > 0 && transcurrido < cooldownMs) {
          //Cuando estamos en modo CAPTCHA y todas las aldeas están en
          //cooldown, sin probe el bot quedaría atascado: nunca claim →
          //nunca detecta resolución. Forzamos UN probe por ciclo (a nivel
          //global, compartido entre ciudades vía cicloState). Si el probe
          //sale OK (Town presente), recolectarAldea llama a
          //onCaptchaResuelto y el ciclo continúa normal.
          if (core.isCaptchaActive() && !cicloState.probeCaptchaUsado) {
            cicloState.probeCaptchaUsado = true;
            core.log(
              "recoleccion",
              `aldea ${aldea.id} (${ciudad.nombreCiudad || ciudad.codigoCiudad}): probe de CAPTCHA (cooldown ignorado)`
            );
            //cae al procesamiento normal abajo
          } else {
            saltadasPorCooldown += 1;
            const restante = Math.round((cooldownMs - transcurrido) / 1000);
            if (restante < restanteMinSeg) restanteMinSeg = restante;
            registrarClaim({
              aldeaId: aldea.id, ciudadId: ciudad.codigoCiudad,
              ciudadNombre: ciudad.nombreCiudad || ciudad.codigoCiudad,
              aldeaNombre: aldea.name || `farm_${aldea.id}`,
              ciclo: nCiclo, status: "saltada-cooldown",
              esperaSeg: restante,
            });
            continue;
          }
        }

        try {
          const r = await recolectarAldea(ciudad, aldea, acumulador, opcion);
          if (r.status === "ok") {
            lastClaimAtPorAldea[aldea.id] = Date.now();
            guardarLastClaimAt();
          } else if (r.status === "reintentar" && pendientes) {
            //Server rechazó (success:false) — encolamos para retry diferido
            //al final del ciclo. Conservamos acumulador+opcion para que la
            //tanda quede correctamente contabilizada cuando el retry funcione.
            pendientes.push({ ciudad, aldea, acumulador, opcion, intentos: 1 });
          }
        } catch (e) {
          core.logError(
            "recoleccion",
            `falló aldea id=${aldea && aldea.id} (${ciudad.nombreCiudad || ciudad.codigoCiudad})`,
            e
          );
          //Network error / abort / parse error — también vale retry porque
          //es transitorio. AbortError de la Fase 5b cae acá.
          if (pendientes) {
            pendientes.push({ ciudad, aldea, acumulador, opcion, intentos: 1 });
          }
        }
        if (core.isCaptchaActive()) break;
      }

      //Log agregado: si hubo aldeas saltadas por cooldown, reportar a nivel
      //de ciudad (en vez de loguear cada aldea individualmente).
      if (saltadasPorCooldown > 0) {
        core.log(
          "recoleccion",
          `${ciudad.nombreCiudad || ciudad.codigoCiudad}: ${saltadasPorCooldown}/${aldeas.length} aldeas en cooldown (${minutos}min) — próxima en ${core.formatDuracion(restanteMinSeg)}`
        );
      }
      //Propagar al global el mínimo entre ciudades — recolectarRecursos lo
      //usa para adelantar el próximo tick si la próxima aldea se libera
      //antes del intervalo normal.
      if (cicloState && restanteMinSeg < cicloState.proximaLiberacionSeg) {
        cicloState.proximaLiberacionSeg = restanteMinSeg;
      }
    }

    /**
     * Reclama una aldea. Retorna un objeto `{ status }` con uno de:
     *   - 'ok'         claim exitoso (server confirmó con notification 'Town')
     *   - 'reintentar' fallo recuperable (success:false del server) — vale la
     *                  pena reintentar al final del ciclo
     *   - 'descartar'  fallo no recuperable en este ciclo (sin relation_id,
     *                  almacén lleno, CAPTCHA, sin Town) — no reintentar
     * El caller (recolectarCiudad) usa el status para decidir si actualiza
     * lastClaimAtPorAldea y/o si encola la aldea para retry.
     */
    async function recolectarAldea(ciudad, aldea, acumulador, opcion) {
      const { recursosLlenos, codigoCiudad } = ciudad;
      const ciudadNombreSafe = ciudad.nombreCiudad || codigoCiudad;
      const aldeaNombreSafe = aldea.name || `farm_${aldea.id}`;

      if (recursosLlenos) {
        core.logWarn(
          "recoleccion",
          `aldea ${aldea.id} (${ciudadNombreSafe}): saltada porque ciudad tiene recursosLlenos=true`
        );
        registrarClaim({
          aldeaId: aldea.id, ciudadId: codigoCiudad,
          ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
          ciclo: nCiclo, status: "descartar",
          errorMsg: "ciudad con recursosLlenos",
        });
        return { status: "descartar" };
      }

      const farmTownId = aldea.id;
      const relationId = data.relacionPorAldea && data.relacionPorAldea[farmTownId];
      if (relationId == null) {
        core.logWarn("recoleccion", `sin relation_id para farm_town_id=${farmTownId} — saltada`);
        registrarClaim({
          aldeaId: farmTownId, ciudadId: codigoCiudad,
          ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
          ciclo: nCiclo, status: "descartar",
          errorMsg: "sin relation_id",
        });
        return { status: "descartar" };
      }

      //Jitter 2.0-2.5s entre claims. Más conservador que 1-1.5s:
      //- reduce presión sobre el server (menos riesgo de success:false y
      //  posibles errores de hidratación de modelos del juego cuando llegan
      //  notifications muy seguidas)
      //- mantiene la huella anti-bot (variabilidad ±25%)
      //- el ciclo crece ~17s con 18 aldeas, todavía muy lejos del cooldown
      //  más corto (5min = 300s). Costo absorbido por el scheduler que ya
      //  resta duracionCiclo del próximo tick (recolectarRecursos).
      await delayMs(jitter(2000, 2500));

      const json = {
        model_url: `FarmTownPlayerRelation/${relationId}`,
        action_name: "claim",
        captcha: null,
        arguments: {
          farm_town_id: farmTownId,
          type: "resources",
          option: opcion,
        },
        town_id: codigoCiudad,
        nl_init: true,
      };

      const datos = new URLSearchParams();
      datos.append("json", JSON.stringify(json));

      //AbortController con timeout de 30s. Sin esto, un fetch que nunca
      //resuelve (TCP sin respuesta, server colgado) deja el ciclo bloqueado
      //para siempre — el scheduler nunca programa el siguiente tick y el
      //bot "se para solo" sin pasar por setPaused. Con el abort, el catch
      //del caller (recolectarCiudad) captura AbortError y el ciclo continúa.
      const ctrl = new AbortController();
      const abortId = setTimeout(() => ctrl.abort(), 30 * 1000);

      let response;
      try {
        response = await fetch(
          `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${codigoCiudad}&action=execute&h=${csrfToken}`,
          {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              accept: "text/plain, */*; q=0.01",
            },
            body: datos,
            signal: ctrl.signal,
          }
        );
      } finally {
        clearTimeout(abortId);
      }
      response = await response.json();

      if (!response.json["success"]) {
        core.logWarn(
          "recoleccion",
          `aldea ${farmTownId} (${ciudadNombreSafe}): server respondió success=false`,
          {
            errors: response.json.errors,
            error_msg: response.json.error_msg,
            notifications: response.json.notifications,
            response: response.json,
          }
        );
        registrarClaim({
          aldeaId: farmTownId, ciudadId: codigoCiudad,
          ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
          ciclo: nCiclo, status: "reintentar",
          errorMsg: (response.json && response.json.error_msg) || "success=false",
        });
        return { status: "reintentar" };
      }

      window.dispatchEvent(
        new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: response.json.notifications },
        })
      );

      const townNotification = response.json.notifications.find(
        (element) => element.subject == "Town"
      );

      if (!townNotification) {
        core.logWarn(
          "recoleccion",
          `sin notificación 'Town' para aldea ${farmTownId} — probable CAPTCHA`,
          response.json.notifications
        );
        core.onCaptchaDetectado();
        registrarClaim({
          aldeaId: farmTownId, ciudadId: codigoCiudad,
          ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
          ciclo: nCiclo, status: "descartar",
          errorMsg: "sin Town notification (probable CAPTCHA)",
        });
        //CAPTCHA → descartar (no reintentar este ciclo). El probe del
        //próximo ciclo se encargará de detectar si se resolvió.
        return { status: "descartar" };
      }

      if (core.isCaptchaActive()) core.onCaptchaResuelto();

      const town = JSON.parse(townNotification.param_str)["Town"];
      const { storage, last_wood, last_iron, last_stone, resources } = town;

      const nombreCiudad = ciudadNombreSafe;
      const nombreAldea = aldeaNombreSafe;
      const prev = recursosPrevPorCiudad[codigoCiudad];
      let claimDeltas = null;
      if (prev && resources) {
        const dW = resources.wood - prev.wood;
        const dS = resources.stone - prev.stone;
        const dI = resources.iron - prev.iron;
        core.log(
          "recoleccion",
          `  ▸ ${nombreCiudad} ← ${nombreAldea} (id ${farmTownId}): ${fmt(dW)}/${fmt(dS)}/${fmt(dI)}  (total ${resources.wood}/${resources.stone}/${resources.iron})`
        );
        if (acumulador) {
          acumulador.wood += dW;
          acumulador.stone += dS;
          acumulador.iron += dI;
          acumulador.claims += 1;
        }
        claimDeltas = { dW, dS, dI };
      } else if (resources) {
        core.log(
          "recoleccion",
          `  ▸ ${nombreCiudad} ← ${nombreAldea} (id ${farmTownId}): recolectada  (total ${resources.wood}/${resources.stone}/${resources.iron})`
        );
        if (acumulador) acumulador.claims += 1;
      }
      if (resources) recursosPrevPorCiudad[codigoCiudad] = { ...resources };

      //Trackeo en cicloActual: contar la aldea como completada y sumar
      //recursos para el progreso en tiempo real del indicador bajo el botón.
      if (cicloActual && cicloActual.ciudades[codigoCiudad]) {
        const c = cicloActual.ciudades[codigoCiudad];
        c.claims += 1;
        if (claimDeltas) {
          c.wood += claimDeltas.dW;
          c.stone += claimDeltas.dS;
          c.iron += claimDeltas.dI;
        }
        cicloActual.aldeasCompletadas += 1;
        if (c.claims >= c.esperado) cicloActual.ciudadesCompletadas += 1;
      }
      actualizarIndicadorVivo();

      const idx = ciudadesConAldeas.findIndex((c) => c.codigoCiudad == codigoCiudad);
      if (idx >= 0) {
        const lleno =
          storage == last_wood && storage == last_iron && storage == last_stone;
        const llenoPrevio = ciudadesConAldeas[idx].recursosLlenos === true;
        ciudadesConAldeas[idx].recursosLlenos = lleno;
        if (lleno && !llenoPrevio) {
          core.logWarn(
            "recoleccion",
            `${nombreCiudad}: recursosLlenos activado tras claim de ${nombreAldea} (id ${farmTownId})`,
            { storage, last_wood, last_iron, last_stone, resources }
          );
        }
      }
      registrarClaim({
        aldeaId: farmTownId, ciudadId: codigoCiudad,
        ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
        ciclo: nCiclo, status: "ok",
        dW: claimDeltas ? claimDeltas.dW : null,
        dS: claimDeltas ? claimDeltas.dS : null,
        dI: claimDeltas ? claimDeltas.dI : null,
        totales: resources ? { wood: resources.wood, stone: resources.stone, iron: resources.iron } : null,
      });
      return { status: "ok" };
    }

    //—— Loaders ————————————————————————————————————————————————————————

    async function obtenerMapaRelaciones() {
      const json = `{"collections":{"FarmTownPlayerRelations":[]},"town_id":${townId},"nl_init":false}`;
      const url = `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${townId}&action=refetch&h=${csrfToken}&json=${encodeURIComponent(json)}`;

      let res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          accept: "text/plain, */*; q=0.01",
        },
      });
      res = await res.json();

      const items =
        (res.json &&
          res.json.collections &&
          res.json.collections.FarmTownPlayerRelations &&
          res.json.collections.FarmTownPlayerRelations.data) ||
        [];

      const mapa = {};
      for (const item of items) {
        const rel = item.d || item;
        if (rel && rel.farm_town_id != null && rel.id != null) {
          mapa[rel.farm_town_id] = rel.id;
        }
      }
      return mapa;
    }

    async function obtenerCiudadesConAldeas() {
      let ciudadesJugador = await fetch(
        `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${townId}&action=refetch&h=${csrfToken}&json={"collections":{"Towns":[]},"town_id":${townId},"nl_init":false}`,
        {
          method: "GET",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            accept: "text/plain, */*; q=0.01",
          },
        }
      );
      ciudadesJugador = await ciudadesJugador.json();
      ciudadesJugador = ciudadesJugador.json.collections.Towns.data;

      //Para reportar cuántas aldeas vienen ya con cooldown server vivo desde
      //el bootstrap. Útil para que el usuario sepa que el primer ciclo va a
      //saltar algunas aldeas no por bug del bot sino porque el server las
      //tiene "ocupadas" desde antes.
      const ahoraSec = Math.floor(Date.now() / 1000);
      let aldeasEnCooldownAlBoot = 0;

      for (const ciudadJugador of ciudadesJugador) {
        const ciudad = ciudadJugador.d;
        await core.delaySeconds(0.2);
        let aldeasCiudad = await fetch(
          `https://${world_id}.grepolis.com/game/island_info?town_id=${ciudad.id}&action=index&h=${csrfToken}&json={"island_id":${ciudad.island_id},"fetch_tmpl":1,"town_id":${ciudad.id},"nl_init":true}`,
          {
            method: "GET",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              accept: "text/plain, */*; q=0.01",
            },
          }
        );
        aldeasCiudad = await aldeasCiudad.json();
        aldeasCiudad = aldeasCiudad.json.json.farm_town_list;

        //Cada aldea trae `loot` (timestamp Unix en segundos): el momento en
        //que vuelve a estar disponible para saquear. Si `loot > now`, el
        //server aún la tiene en cooldown — el bot lo respeta en el primer
        //ciclo (recolectarCiudad mira `aldea.loot` cuando no hay entrada
        //en lastClaimAtPorAldea para esa aldea).
        if (Array.isArray(aldeasCiudad)) {
          for (const a of aldeasCiudad) {
            if (a && a.loot && a.loot > ahoraSec) aldeasEnCooldownAlBoot += 1;
          }
        }

        ciudadesConAldeas.push({
          codigoCiudad: ciudad.id,
          nombreCiudad: ciudad.name,
          aldeas: aldeasCiudad,
        });

        data.ciudadesConAldeas = ciudadesConAldeas;
      }

      if (aldeasEnCooldownAlBoot > 0) {
        core.log(
          "recoleccion",
          `sincronización con server: ${aldeasEnCooldownAlBoot} aldea(s) ya en cooldown — se respetarán en el primer ciclo`
        );
      }
    }
  }

  JamBot.features.recoleccion = { init };
})();
