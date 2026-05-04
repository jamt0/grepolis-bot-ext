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

    //—— Historial por aldea + ciclos completos ——————————————————————————
    //
    //HISTORIAL_MAX = 36 últimos intentos por aldea (FIFO). 36 = ~6 horas a
    //un ciclo cada 10min — alcanza para revisar la noche/mañana anterior.
    //Para 50 ciudades: 50 × 6 × 36 × ~250 B ≈ 2.7 MB, ≈ 27% de la cuota
    //chrome.storage.local (10 MB) — holgado.
    //
    //CICLOS_MAX = 36 ciclos completos persistidos (mismo horizonte que el
    //historial por aldea). Cada uno guarda el resumen por ciudad — el
    //panel los muestra en una lista colapsable, el más reciente expandido.
    //
    //Estructuras:
    //  historialPorAldea[aldeaId] = [{ts, ciudadId, ciudadNombre,
    //                                 aldeaNombre, ciclo, status,
    //                                 dW, dS, dI, intentos, errorMsg}]
    //  ciclos[]     = [{ n, inicio, fin, duracion, captchaDurante,
    //                    ciudades: { [id]: { nombre, claims, esperado,
    //                                        wood, stone, iron,
    //                                        aldeasFalladas: [...] } } }]
    //                 (el último elemento es el ciclo más reciente)
    //  cicloActual  = mismo shape que un ciclo, pero `fin/duracion` null
    //                 mientras el ciclo está corriendo. Se promueve a
    //                 ciclos[] cuando termina.
    const HISTORIAL_MAX = 36;
    const CICLOS_MAX = 36;
    const STORAGE_KEY_HISTORIAL = `jambotHistorial_${world_id}`;
    let historialPorAldea = {};
    let ciclos = [];
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
    const relInfo = await obtenerMapaRelaciones();
    data.relacionPorAldea = relInfo.relacionPorAldea;
    //Auto-detección del cooldown por ciudad (5 o 10 min). Lo derivamos
    //del propio modelo del server (FarmTownPlayerRelation.lootable_at -
    //last_looted_at) — ver detectarMinutosCiudad. Se rebuilda en
    //`recalcularCooldownsAuto()` cuando hay datos nuevos (después del
    //primer claim de una ciudad nueva, o post-CAPTCHA sync).
    let cooldownSegPorAldea = relInfo.cooldownSegPorAldea;
    const cooldownPorCiudad = {};
    function recalcularCooldownsAuto() {
      for (const ciudad of ciudadesConAldeas) {
        cooldownPorCiudad[ciudad.codigoCiudad] = detectarMinutosCiudad(ciudad);
      }
    }
    recalcularCooldownsAuto();

    /**
     * Re-pide la colección de relaciones al server y recalcula la
     * auto-detección. Se llama al final de un ciclo si quedó alguna ciudad
     * en `fallback` (sin claim histórico) — normalmente porque es una ciudad
     * recién fundada y el bot acaba de hacer el primer claim. Una vez que
     * todas resuelven con `fuente: "auto"` deja de llamarse.
     *
     * Costo: 1 GET adicional al servidor por ciclo, solo mientras haya
     * ciudades en fallback. Es transparente para el ciclo (corre después
     * de que ya se programó el siguiente tick).
     */
    async function refrescarCooldownsAuto() {
      try {
        const fresco = await obtenerMapaRelaciones();
        data.relacionPorAldea = fresco.relacionPorAldea;
        cooldownSegPorAldea = fresco.cooldownSegPorAldea;
        recalcularCooldownsAuto();
      } catch (e) {
        core.logWarn("recoleccion", "no pude refrescar cooldowns auto", e);
      }
    }
    function hayCiudadesEnFallback() {
      for (const v of Object.values(cooldownPorCiudad)) {
        if (v && v.fuente !== "auto") return true;
      }
      return false;
    }
    //Restaurar el map de lastClaimAt persistido del mundo actual. Si el
    //bot estuvo corriendo y la pestaña se recargó, esto evita que el primer
    //ciclo dispare aldeas con cooldown server vivo.
    lastClaimAtPorAldea = await cargarLastClaimAt();
    //Restaurar historial + último ciclo. Sobreviven al reload para que el
    //panel de Recolección muestre datos significativos en cuanto se abre,
    //sin esperar al primer ciclo nuevo.
    const histData = await cargarHistorial();
    historialPorAldea = histData.porAldea;
    ciclos = histData.ciclos;
    //Recuperar ciclo interrumpido. Si el ciclo anterior se cortó a media
    //tanda (F5, extensión recargada, crash) el storage tiene un snapshot de
    //cicloActual con `fin: null` y aldeasCompletadas > 0. Lo promovemos a
    //ciclos[] marcado como interrumpido para que aparezca en el historial.
    //Si aldeasCompletadas == 0 lo descartamos: significa que el ciclo se
    //inicializó pero murió antes del primer claim — cero info útil.
    let cicloRecuperado = 0;
    if (histData.cicloEnCurso && histData.cicloEnCurso.aldeasCompletadas > 0) {
      const c = histData.cicloEnCurso;
      c.interrumpido = true;
      c.fin = c.ultimoClaimAt || c.inicio;
      c.duracion = c.fin - c.inicio;
      ciclos.push(c);
      while (ciclos.length > CICLOS_MAX) ciclos.shift();
      cicloRecuperado = c.aldeasCompletadas;
    }
    const resumenAuto = (() => {
      let ok = 0, fb = 0, c5 = 0, c10 = 0;
      for (const v of Object.values(cooldownPorCiudad)) {
        if (v.fuente === "auto") ok += 1; else fb += 1;
        if (v.minutos === 5) c5 += 1; else c10 += 1;
      }
      return `auto=${ok}/fallback=${fb} · 5min=${c5} · 10min=${c10}`;
    })();
    const sufijoRecup = cicloRecuperado > 0 ? ` · ciclo interrumpido recuperado (${cicloRecuperado} aldeas)` : "";
    core.log(
      "recoleccion",
      `carga OK · ciudades=${ciudadesConAldeas.length} · relaciones=${Object.keys(data.relacionPorAldea || {}).length} · cooldown ${resumenAuto} · lastClaimAt persistidos=${Object.keys(lastClaimAtPorAldea).length} · historial=${Object.keys(historialPorAldea).length} aldeas · ciclos persistidos=${ciclos.length}${sufijoRecup}`,
      "ok"
    );

    //Limpieza de la config legacy `porCiudad` (5/10min manual). Si el
    //usuario tenía la versión anterior, el storage trae esa key — la
    //borramos al boot porque ahora todo es auto. No tocamos otras keys
    //del mismo blob (e.g. `finalizarHabilitado`).
    chrome.storage.local.get("jambotConfig", (obj) => {
      const cfg = obj && obj.jambotConfig;
      if (cfg && cfg.porCiudad) {
        const resto = { ...cfg };
        delete resto.porCiudad;
        chrome.storage.local.set({ jambotConfig: resto });
      }
    });

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
      //Si la extensión fue recargada, isExtensionContextValid loggea una
      //sola vez + pausa el bot. Salir sin tocar storage evita el spam de
      //"Extension context invalidated" (1 por aldea × 6 aldeas × N ciudades).
      if (!core.isExtensionContextValid()) return;
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
          //Retrocompatibilidad: las versiones previas guardaban solo el
          //último ciclo en `ultimoCiclo`. Si encontramos ese formato lo
          //promovemos a un array de un elemento. Las próximas escrituras
          //ya van a usar el formato nuevo `ciclos`.
          const ciclos = Array.isArray(blob.ciclos)
            ? blob.ciclos
            : (blob.ultimoCiclo ? [blob.ultimoCiclo] : []);
          resolve({
            porAldea: blob.porAldea || {},
            ciclos: ciclos,
            //cicloEnCurso: snapshot del ciclo que estaba corriendo cuando la
            //pestaña se cerró/recargó. Si tiene aldeasCompletadas > 0 lo
            //promovemos a ciclos[] como interrumpido en el bootstrap, así no
            //se pierde el progreso parcial. Ver flujo en líneas ~136-160.
            cicloEnCurso: blob.cicloEnCurso || null,
          });
        });
      });
    }

    //Snapshot persistible de cicloActual. JSON.parse(JSON.stringify) garantiza
    //que las mutaciones in-memory posteriores al set() no afecten el blob ya
    //serializado por chrome.storage. Sin esto, dos guardarHistorial() casi
    //simultáneos podrían escribir referencias compartidas y truncarse mal.
    function snapshotCicloActual() {
      return cicloActual ? JSON.parse(JSON.stringify(cicloActual)) : null;
    }

    function guardarHistorial() {
      if (!core.isExtensionContextValid()) return;
      try {
        chrome.storage.local.set({
          [STORAGE_KEY_HISTORIAL]: {
            porAldea: historialPorAldea,
            ciclos: ciclos,
            cicloEnCurso: snapshotCicloActual(),
          },
        });
      } catch (e) {
        core.logWarn("recoleccion", "no pude persistir historial", e);
      }
    }

    //Versión que retorna Promise — usada en la promoción del ciclo para
    //garantizar que el ciclo recién terminado llegue al disco ANTES de
    //volver a programar el siguiente tick. Sin esto, un reload de la
    //pestaña entre el push a ciclos[] y el set() async (~10-50ms) perdía
    //el ciclo entero.
    function guardarHistorialAsync() {
      if (!core.isExtensionContextValid()) return Promise.resolve();
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({
            [STORAGE_KEY_HISTORIAL]: {
              porAldea: historialPorAldea,
              ciclos: ciclos,
              cicloEnCurso: snapshotCicloActual(),
            },
          }, resolve);
        } catch (e) {
          core.logWarn("recoleccion", "no pude persistir historial", e);
          resolve();
        }
      });
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
      ciclos = [];
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
        ciclos,
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


    /**
     * Determina el cooldown real (en minutos) que tiene una ciudad para la
     * recolección "Recoger" (option=1). Devuelve { minutos, fuente, lealtad }.
     *
     * - fuente="auto": se infirió mirando alguna aldea de la ciudad con
     *   `lootable_at - last_looted_at` válido (≈300s ⇒ 5min sin Lealtad,
     *   ≈600s ⇒ 10min con Lealtad). Es la fuente confiable.
     * - fuente="fallback": ninguna aldea de la ciudad tiene claim histórico
     *   (ciudad recién fundada o storage del server reseteado). Usamos el
     *   default de data.json — se auto-corrige sola en el primer ciclo
     *   después del primer claim, cuando recalcularCooldownsAuto() se ejecuta.
     *
     * IMPORTANTE: la habilidad "Lealtad de los Aldeanos" se estudia POR
     * CIUDAD y duplica el cooldown (5min → 10min) a cambio de +115% de
     * recursos. Por eso basta con UNA aldea de la ciudad para inferirlo —
     * todas comparten la misma habilidad.
     */
    function detectarMinutosCiudad(ciudad) {
      const aldeas = ciudad.aldeas || [];
      for (const a of aldeas) {
        const seg = cooldownSegPorAldea[a.id];
        if (!seg) continue;
        //Buckets con margen ±60s para drift / cooldowns parcialmente
        //avanzados. Cualquier valor fuera de los buckets esperados es
        //sospechoso pero asumimos el más cercano.
        if (seg < 450) return { minutos: 5, fuente: "auto", lealtad: false };
        return { minutos: 10, fuente: "auto", lealtad: true };
      }
      return {
        minutos: data.tiempoRecoleccion || 5,
        fuente: "fallback",
        lealtad: null,
      };
    }

    function getConfigCiudad(codigoCiudad) {
      const det = cooldownPorCiudad[codigoCiudad];
      const minutos = (det && det.minutos) || data.tiempoRecoleccion || 5;
      //IMPORTANTE: option=1 SIEMPRE — es el primer botón "Recoger" del juego,
      //el más corto y más rentable. Su duración real depende de si la ciudad
      //estudió la habilidad de academia "Lealtad de los Aldeanos" (duplica
      //tiempos, +115% recursos): sin habilidad rinde 5min, con habilidad
      //rinde 10min. Antes el usuario configuraba 5/10 manualmente por
      //ciudad; ahora se auto-detecta vía detectarMinutosCiudad. Las opciones
      //2-4 del juego (10/20/4h sin habilidad, 40min/3h/8h con habilidad) no
      //se usan nunca: rinden peor por hora y se acumula riesgo de almacén
      //lleno.
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
    //mismo payload repetido. `jitter()` varía el tiempo entre claims y entre
    //ciclos para romper esos patrones.
    //
    //Antes había también un `shuffle()` que barajaba aldeas dentro de cada
    //ciudad — se eliminó porque rompía la fórmula de esperaNormal (ver §6.2
    //de docs/recoleccion.md). El orden de aldeas ahora es determinista
    //alfabético-natural por nombre.

    function jitter(minMs, maxMs) {
      return minMs + Math.random() * (maxMs - minMs);
    }

    function delayMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    //—— UI ——————————————————————————————————————————————————————————————
    //
    //Una sola "card" arriba de los islotes inferiores: ícono slime + "Jam"
    //+ estado (▶/⏸/⚠). Click en cualquier parte abre el panel. El
    //play/pause y la configuración viven AHORA dentro del panel — antes
    //eran 2 botones flotantes separados que ocupaban espacio y se podían
    //clickear sin querer. Esta card es solo un "abridor".

    const panelConfig = crearPanelConfig();
    crearCardJam();

    function crearCardJam() {
      //Reusamos el contenedor #jambot-buttons que crea core.js (sigue
      //existiendo para que el indicador en tiempo real pueda anclar ahí).
      const cont = (function () {
        let c = document.getElementById("jambot-buttons");
        if (c) return c;
        c = document.createElement("div");
        c.id = "jambot-buttons";
        c.style.cssText =
          "position:absolute;bottom:45px;left:80px;z-index:5;" +
          "display:flex;flex-direction:column;gap:6px;align-items:flex-start";
        document.body.appendChild(c);
        return c;
      })();

      const card = document.createElement("div");
      card.id = "jambot-card";
      card.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:7px 12px 7px 8px;" +
        "background:#1f2a36;color:#cdd5e0;border:1px solid #2c3a4d;" +
        "border-radius:6px;cursor:pointer;user-select:none;" +
        "font-family:'Segoe UI',sans-serif;font-size:13px;font-weight:bold;" +
        "letter-spacing:0.3px;box-shadow:0 2px 6px rgba(0,0,0,0.3);" +
        "transition:background 0.15s,border-color 0.15s";
      //SVG slime: blob verde con dos ojitos. No hay emoji estándar de
      //slime; un SVG inline queda más limpio que cualquier emoji forzado.
      card.innerHTML =
        `<svg width="22" height="22" viewBox="0 0 24 24" style="flex-shrink:0">
           <ellipse cx="12" cy="19" rx="10" ry="3" fill="rgba(0,0,0,0.25)"/>
           <path d="M3 17 Q3 7 12 5 Q21 7 21 17 Q21 20 12 20 Q3 20 3 17 Z"
                 fill="#27ae60" stroke="#1e8449" stroke-width="0.8"/>
           <path d="M5 12 Q12 4 19 12 Q12 9 5 12 Z" fill="rgba(255,255,255,0.18)"/>
           <circle cx="9" cy="13" r="1.6" fill="#fff"/>
           <circle cx="15" cy="13" r="1.6" fill="#fff"/>
           <circle cx="9.4" cy="13.4" r="0.7" fill="#0a0a0a"/>
           <circle cx="15.4" cy="13.4" r="0.7" fill="#0a0a0a"/>
         </svg>
         <span>Jam</span>
         <span id="jambot-card-estado" style="margin-left:4px;font-size:14px"></span>
         <span id="jambot-card-countdown" style="margin-left:6px;font-size:11px;font-family:monospace;color:#7a8aa0;font-weight:normal"></span>`;
      card.addEventListener("mouseenter", () => {
        card.style.background = "#26344a";
        card.style.borderColor = "#3498db";
      });
      card.addEventListener("mouseleave", () => {
        card.style.background = "#1f2a36";
        card.style.borderColor = "#2c3a4d";
      });
      card.addEventListener("click", () => {
        //Click en la card normalmente lleva a Dashboard. EXCEPCIÓN: cuando
        //hay CAPTCHA pendiente, lleva a Recolección — ahí está el cartel
        //con el botón "Ya resolví", que es lo único que el usuario quiere
        //hacer en ese momento.
        const tabDestino = core.isCaptchaActive() ? "recoleccion" : "dashboard";
        const panel = document.getElementById("panelConfigJam");
        const cerrado = !panel || panel.style.display === "none";
        if (cerrado) {
          tabActivo = tabDestino;
          window.localStorage.setItem(STORAGE_KEY_TAB, tabDestino);
          abrirPanel(panelConfig);
        } else if (tabActivo !== tabDestino) {
          tabActivo = tabDestino;
          window.localStorage.setItem(STORAGE_KEY_TAB, tabDestino);
          renderPanelConfig(panelConfig);
        } else {
          cerrarPanel(panelConfig);
        }
      });
      cont.appendChild(card);
      return card;
    }

    function actualizarEstadoCard() {
      const card = document.getElementById("jambot-card");
      const span = document.getElementById("jambot-card-estado");
      const captchaActivo = core.isCaptchaActive();
      const captchaState = core.getCaptchaState ? core.getCaptchaState() : "none";
      const ctx = core.getCaptchaContext ? core.getCaptchaContext() : null;
      const resueltoEnJuego = core.isCaptchaResueltoEnJuego && core.isCaptchaResueltoEnJuego();

      if (span) {
        if (captchaActivo) {
          span.textContent = captchaState === "timeout" ? "⏱" : "⚠";
          span.style.color = captchaState === "timeout" ? "#7a8aa0" : "#e74c3c";
        } else if (core.isPaused()) {
          span.textContent = "▶";
          span.style.color = "#27ae60";
        } else {
          //Corriendo: sin icono. El countdown / spinner indican actividad.
          //Antes mostrábamos ⏸ pero confunde — leer "pausa" cuando en
          //realidad está corriendo.
          span.textContent = "";
        }
      }

      //Cuando hay CAPTCHA, además del ⚠ pintamos el borde rojo (o verde
      //si el bridge ya detectó que el captcha del juego se limpió y solo
      //falta el click "Ya resolví"). En timeout queda gris.
      if (card) {
        if (captchaActivo) {
          card.style.borderColor =
            captchaState === "timeout" ? "#7a8aa0" :
            resueltoEnJuego ? "#27ae60" : "#e74c3c";
          //Tooltip con el contexto.
          if (ctx && ctx.ciudad && ctx.aldea) {
            card.title = `CAPTCHA · ${ctx.ciudad.nombre} → ${ctx.aldea.nombre} (click para resolver)`;
          } else {
            card.title = "CAPTCHA pendiente — click para resolver";
          }
        } else {
          //Restaurar el borde default (lo manejan los hover handlers).
          card.style.borderColor = "#2c3a4d";
          card.title = "";
        }
      }

      //Indicador secundario (countdown / spinner / texto CAPTCHA).
      const cd = document.getElementById("jambot-card-countdown");
      if (cd) {
        if (captchaActivo && ctx && ctx.aldea) {
          //Mostrar la aldea que falló — el usuario lee el pulpo y ya sabe
          //cuál tiene que recolectar manual sin abrir el panel.
          cd.innerHTML = `<span style="color:#f39c12">${escapeHtml(ctx.aldea.nombre)}</span>`;
        } else if (cicloActual) {
          cd.innerHTML = `<span class="jambot-spinner"></span>`;
        } else if (proximoTickAt && !core.isPaused()) {
          const seg = Math.max(0, Math.round((proximoTickAt - Date.now()) / 1000));
          cd.textContent = core.formatDuracion(seg);
        } else {
          cd.innerHTML = "";
        }
      }
    }
    actualizarEstadoCard();
    //Tick de 1s SOLO para refrescar el countdown al próximo ciclo.
    //El spinner es CSS puro y los demás estados se actualizan por evento
    //(onPlayPauseChange/onCaptcha) o por llamadas explícitas, así que el
    //interval en sí mismo no es necesario para esos casos. Igual lo
    //dejamos siempre activo: actualizarEstadoCard es barato (lee globals
    //y toca 2-3 nodos) y simplifica el ciclo de vida — no hay que
    //arrancar/parar el interval según el estado.
    setInterval(actualizarEstadoCard, 1000);

    //Reaccionar al play/pause global: cancelar tick al pausar, arrancar al
    //despausar. El estado se sincroniza con `core.isPaused()`.
    core.onPlayPauseChange((p) => {
      if (p) {
        if (proximoTickId) clearTimeout(proximoTickId);
        if (watchdogId) clearTimeout(watchdogId);
        proximoTickId = null;
        proximoTickAt = null;
        watchdogId = null;
        actualizarEstadoCard();
      } else {
        actualizarEstadoCard();
        recolectarRecursos();
      }
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
    const TABS_VALIDOS = ["dashboard", "settings", "recoleccion", "construccion"];
    let tabActivo = window.localStorage.getItem(STORAGE_KEY_TAB) || "dashboard";
    if (!TABS_VALIDOS.includes(tabActivo)) tabActivo = "dashboard";
    //Estado de colapso del UI — vive en memoria nomás, no persiste.
    //  ciclos:        { actual: bool, ultimo: bool }      true = expandido
    //  aldeas:        { [id]: bool }                      true = expandido (historial)
    //  cicloCiudades: { [n]: { [id]: bool } }             true = expandido (ciudad dentro de un ciclo)
    const uiColapso = {
      ciclos: { actual: true, ultimo: true },
      aldeas: {},
      cicloCiudades: {},
      errores: false,
    };

    function crearPanelConfig() {
      //Inyectar el <style> block una sola vez. Inline-style no soporta
      //pseudo-clases (:hover) ni transitions complejas — necesitamos CSS
      //real. Lo agregamos al <head> con id para no duplicar si la feature
      //se reinicializa.
      if (!document.getElementById("jambot-styles")) {
        const style = document.createElement("style");
        style.id = "jambot-styles";
        style.textContent = `
          .pcj-row { transition: background 0.12s; }
          .pcj-row:hover { background: rgba(255,255,255,0.04) !important; }
          #panelConfigJam button:focus { outline: 2px solid #3498db44; outline-offset: 1px; }

          /* Spinner para la card "Jam" cuando hay un ciclo en curso.
             CSS-only (no depende de re-renders en JS). */
          @keyframes jb-spin { to { transform: rotate(360deg); } }
          .jambot-spinner {
            display: inline-block;
            width: 11px; height: 11px;
            border: 2px solid rgba(255,255,255,0.15);
            border-top-color: #f39c12;
            border-radius: 50%;
            animation: jb-spin 0.8s linear infinite;
            vertical-align: -1px;
          }

          /* Scrollbar custom alineado con el dark theme del panel.
             Solo aplica al body con scroll y a cualquier descendiente que
             scrollee. Webkit-only — Firefox usa scrollbar-width/color. */
          #panelConfigJam *::-webkit-scrollbar { width: 8px; height: 8px; }
          #panelConfigJam *::-webkit-scrollbar-track { background: transparent; }
          #panelConfigJam *::-webkit-scrollbar-thumb {
            background: #2c3a4d;
            border-radius: 4px;
            border: 1px solid #1f2a36;
          }
          #panelConfigJam *::-webkit-scrollbar-thumb:hover { background: #3498db; }
          #panelConfigJam *::-webkit-scrollbar-corner { background: transparent; }
          #panelConfigJam { scrollbar-width: thin; scrollbar-color: #2c3a4d transparent; }
          #panelConfigJam *  { scrollbar-width: thin; scrollbar-color: #2c3a4d transparent; }
        `;
        document.head.appendChild(style);
      }

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
        //bottom:160px deja un margen visible entre el panel y la cola de
        //construcción (antes 110px quedaba pegado).
        //z-index:9999 — el PANEL va por encima de los modales del juego
        //(antes quedaba tapado por ventanas como el reporte de batalla).
        //Los BOTONES siguen en z-index:5 para no recibir clicks accidentales
        //de modales que se cierran encima de ellos (ver core.js).
        "position:absolute;bottom:160px;left:50%;transform:translateX(-50%);z-index:9999;" +
        "background:#1f2a36;color:#e6e9ee;padding:0;border:1px solid #2c3a4d;" +
        "border-radius:6px;display:none;" +
        "width:70vw;min-width:460px;max-width:900px;" +
        "height:70vh;max-height:calc(100vh - 190px);" +
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
      //Click sobre la card "Jam" → no cerrar acá; el handler de la card
      //se encarga del toggle (sino quedaría abre/cierra/abre en el mismo
      //click).
      const cardJam = document.getElementById("jambot-card");
      if (cardJam && cardJam.contains(e.target)) return;
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
        if (tabActivo === "dashboard") renderTabDashboard(body);
        else if (tabActivo === "recoleccion") renderTabRecoleccion(body);
        else if (tabActivo === "construccion") renderTabConstruccion(body);
      }, 1000);
      //Capture phase para correr antes que el click handler del botón ⚙
      //(que de todos modos nos retornamos antes en outsideClickHandler).
      document.addEventListener("mousedown", outsideClickHandler, true);
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

      //Header de control: pill de estado + countdown + botón play/pause.
      //FIJO en todos los tabs (antes vivía solo en el Dashboard).
      const header = document.createElement("div");
      header.id = "panelHeaderEstado";
      header.style.cssText =
        "padding:10px 12px;border-bottom:1px solid #2c3a4d;background:#1a232e";
      panel.appendChild(header);
      actualizarHeaderPanel(panel);

      //Tabs
      const tabs = document.createElement("div");
      tabs.className = "pcj-tabs";
      tabs.style.cssText =
        "display:flex;border-bottom:1px solid #2c3a4d;background:#172029";
      tabs.appendChild(crearBotonTab("dashboard", "Dashboard"));
      tabs.appendChild(crearBotonTab("settings", "Settings"));
      tabs.appendChild(crearBotonTab("recoleccion", "Recolección"));
      tabs.appendChild(crearBotonTab("construccion", "Construcción"));
      panel.appendChild(tabs);

      //Body del tab activo. flex:1 + min-height:0 + overflow-y:auto hace
      //que el body absorba el espacio restante del panel (después de
      //titulo+header+tabs) y muestre scroll vertical cuando el contenido
      //excede. Sin min-height:0 el flex item nunca achica abajo del
      //contenido y el scroll no aparece.
      const body = document.createElement("div");
      body.className = "pcj-body";
      body.style.cssText =
        "padding:10px 12px;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden";
      panel.appendChild(body);
      renderTabActivo(body);
    }

    function crearBotonTab(id, label) {
      const b = document.createElement("button");
      b.textContent = label;
      const activo = tabActivo === id;
      b.style.cssText =
        `flex:1;padding:10px 12px;background:${activo ? "#1f2a36" : "transparent"};` +
        `color:${activo ? "#3498db" : "#7a8aa0"};border:none;` +
        `border-bottom:2px solid ${activo ? "#3498db" : "transparent"};` +
        "cursor:pointer;font-weight:bold;font-size:12px;letter-spacing:0.3px;" +
        "transition:all 0.15s";
      if (!activo) {
        b.addEventListener("mouseenter", () => {
          b.style.background = "#1a232e";
          b.style.color = "#cdd5e0";
        });
        b.addEventListener("mouseleave", () => {
          b.style.background = "transparent";
          b.style.color = "#7a8aa0";
        });
      }
      b.addEventListener("click", () => {
        tabActivo = id;
        window.localStorage.setItem(STORAGE_KEY_TAB, id);
        renderPanelConfig(document.getElementById("panelConfigJam"));
      });
      return b;
    }

    function renderTabActivo(body) {
      body.innerHTML = "";
      if (tabActivo === "dashboard") renderTabDashboard(body);
      else if (tabActivo === "settings") renderTabSettings(body);
      else if (tabActivo === "construccion") renderTabConstruccion(body);
      else renderTabRecoleccion(body);
    }

    function actualizarHeaderPanel(panel) {
      const header = panel.querySelector("#panelHeaderEstado");
      if (!header) return;

      const captcha = core.isCaptchaActive();
      const captchaState = core.getCaptchaState ? core.getCaptchaState() : (captcha ? "pending" : "none");
      const pausado = core.isPaused();
      //En "pending" mostramos pill rojo "CAPTCHA" y deshabilitamos el botón
      //(el usuario tiene que resolver vía el cartel del tab Recolección).
      //En "timeout" mostramos pill gris "TIMEOUT" pero el botón Iniciar SE
      //HABILITA — apretarlo limpia el captcha y arranca un ciclo nuevo.
      const colorPill =
        captchaState === "pending" ? "#e74c3c" :
        captchaState === "timeout" ? "#7a8aa0" :
        pausado ? "#27ae60" : "#3498db";
      const label =
        captchaState === "pending" ? "CAPTCHA" :
        captchaState === "timeout" ? "TIMEOUT" :
        pausado ? "Pausado" : "Corriendo";

      let proximoTexto = "—";
      let proximoColor = "#cdd5e0";
      if (cicloActual) {
        proximoTexto = `en curso · ${cicloActual.ciudadesCompletadas}/${cicloActual.totalCiudades} ciud · ${cicloActual.aldeasCompletadas}/${cicloActual.totalAldeas} aldeas`;
        proximoColor = "#f39c12";
      } else if (proximoTickAt) {
        proximoTexto = "próximo en " + core.formatDuracion((proximoTickAt - Date.now()) / 1000);
      } else if (captchaState === "pending") {
        proximoTexto = "esperando que el humano resuelva el CAPTCHA";
        proximoColor = "#e74c3c";
      } else if (captchaState === "timeout") {
        proximoTexto = "bot detenido — iniciá para arrancar un nuevo ciclo";
        proximoColor = "#cdd5e0";
      }

      header.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;align-items:center;gap:10px";

      const izq = document.createElement("div");
      izq.style.cssText = "flex:1;display:flex;align-items:center;gap:10px;flex-wrap:wrap";
      izq.innerHTML =
        statusPill(label, colorPill) +
        `<span style="color:${proximoColor};font-size:11.5px">${proximoTexto}</span>`;
      wrap.appendChild(izq);

      //El botón usa el color de play/pause "real" (no el del captcha pill)
      //para que sea visualmente claro que apretarlo cambia ese estado.
      const colorBtn = pausado ? "#27ae60" : "#3498db";
      const btn = document.createElement("button");
      const accion = pausado ? "Iniciar" : "Pausar";
      btn.textContent = (pausado ? "▶  " : "⏸  ") + accion;
      btn.style.cssText =
        `padding:6px 14px;background:${colorBtn};color:#fff;border:none;` +
        "border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;" +
        "letter-spacing:0.3px;transition:opacity 0.15s;flex-shrink:0";
      const bloqueadoPorCaptcha = captchaState === "pending";
      if (bloqueadoPorCaptcha) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
        btn.title = "Resolvé el CAPTCHA primero (botón en el tab Recolección)";
      }
      btn.addEventListener("click", () => {
        if (bloqueadoPorCaptcha) return;
        //En "timeout" el captcha sigue activo; al iniciar limpiamos el
        //estado para arrancar un ciclo nuevo limpio (los cooldowns por
        //aldea siguen vivos en lastClaimAtPorAldea, no se pierden).
        if (captchaState === "timeout" && pausado) {
          core.onCaptchaResuelto();
        }
        core.togglePlayPause();
        //Repaint inmediato del header — sin esto el botón se quedaba con
        //el label viejo hasta el siguiente tick del setInterval (1s),
        //como si el click no hubiera tomado.
        actualizarHeaderPanel(panel);
      });
      wrap.appendChild(btn);

      header.appendChild(wrap);
    }

    //—— Tab Dashboard ——————————————————————————————————————————————————
    //
    //Vista mínima de "cómo va el bot": agregados de los ciclos persistidos.
    //Sin contadores en vivo que cambien cada segundo (eso vive en los tabs
    //específicos), solo métricas que cambian al cierre de cada ciclo.
    //
    //IMPORTANTE: este render LIMPIA el body al inicio. El bug previo era
    //que el setInterval del panel y el botón play/pause re-renderizaban
    //sin limpiar → cada segundo se duplicaba todo el contenido (ciclo
    //infinito visual).

    function renderTabDashboard(body) {
      body.innerHTML = "";
      //La barra de estado + botón play/pause vive en el header global del
      //panel (visible en TODOS los tabs), no acá. Antes estaba duplicada
      //en este Dashboard — quedaba inconsistente al saltar a otros tabs.

      //Métricas de Recolección
      body.appendChild(crearTituloSeccion("Recolección"));
      body.appendChild(renderMetricasRecoleccion());

      //Métricas de Construcción
      body.appendChild(crearTituloSeccion("Construcción"));
      body.appendChild(renderMetricasConstruccion());
    }

    function renderMetricasRecoleccion() {
      //Calcular agregados sobre TODOS los ciclos persistidos.
      let aldeasOk = 0;
      let aldeasError = 0;
      let totWood = 0, totStone = 0, totIron = 0;
      let ciclosCompletos = 0;
      for (const c of ciclos) {
        let cicloOk = true;
        for (const cd of Object.values(c.ciudades || {})) {
          aldeasOk += cd.claims || 0;
          aldeasError += Math.max(0, (cd.esperado || 6) - (cd.claims || 0));
          totWood += cd.wood || 0;
          totStone += cd.stone || 0;
          totIron += cd.iron || 0;
          if ((cd.claims || 0) < (cd.esperado || 6)) cicloOk = false;
        }
        if (cicloOk) ciclosCompletos += 1;
      }
      const aldeasTotal = aldeasOk + aldeasError;
      const tasa = aldeasTotal > 0 ? Math.round((aldeasOk / aldeasTotal) * 100) : 100;

      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px";
      wrap.appendChild(stat(
        "Ciclos OK",
        ciclos.length === 0 ? "0" : `${ciclosCompletos}/${ciclos.length}`,
        ciclos.length === 0 ? null : (ciclosCompletos === ciclos.length ? "#27ae60" : "#f39c12")
      ));
      wrap.appendChild(stat(
        "Tasa de éxito",
        `${tasa}%`,
        aldeasTotal === 0 ? null : (tasa >= 95 ? "#27ae60" : tasa >= 80 ? "#f39c12" : "#e74c3c")
      ));
      wrap.appendChild(stat("Aldeas farmeadas", String(aldeasOk), aldeasOk > 0 ? "#27ae60" : null));
      wrap.appendChild(stat("Aldeas con error", String(aldeasError), aldeasError > 0 ? "#e74c3c" : null));

      //Recursos en card ancha (con íconos)
      const card = document.createElement("div");
      card.style.cssText =
        "grid-column:1 / -1;padding:8px 12px;background:#172029;" +
        "border-left:3px solid #27ae60;border-radius:3px";
      card.innerHTML =
        `<div style="color:#7a8aa0;text-transform:uppercase;letter-spacing:0.6px;font-size:9.5px;font-weight:bold;margin-bottom:4px">Recursos acumulados</div>` +
        `<div style="font-size:13px;color:#e6e9ee;font-weight:bold">${recursosConIconos(totWood, totStone, totIron)}</div>`;
      wrap.appendChild(card);

      return wrap;
    }

    function renderMetricasConstruccion() {
      const ds = data.construccion;
      const finalizadas = (ds && ds.finalizadas) || [];
      const ultima = finalizadas[finalizadas.length - 1];

      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px";

      const habilitada = ds && ds.habilitada;
      wrap.appendChild(stat(
        "Estado",
        habilitada ? "Activa" : "Deshabilitada",
        habilitada ? "#3498db" : "#7a8aa0"
      ));
      wrap.appendChild(stat(
        "Edificios finalizados",
        String(finalizadas.length),
        finalizadas.length > 0 ? "#27ae60" : null
      ));

      if (ultima) {
        const card = document.createElement("div");
        card.style.cssText =
          "grid-column:1 / -1;padding:8px 12px;background:#172029;" +
          "border-left:3px solid #27ae60;border-radius:3px";
        card.innerHTML =
          `<div style="color:#7a8aa0;text-transform:uppercase;letter-spacing:0.6px;font-size:9.5px;font-weight:bold;margin-bottom:4px">Última finalizada</div>` +
          `<div style="font-size:12.5px;color:#e6e9ee">` +
          `<span style="font-weight:bold">${escapeHtml(ultima.town_nombre || ultima.town_id)}</span>` +
          ` <span style="color:#7a8aa0">←</span> ` +
          `<span style="font-family:monospace;color:#cdd5e0">${escapeHtml(ultima.building_type)}</span>` +
          ` <span style="color:#7a8aa0">·</span> ` +
          `<span style="color:#7a8aa0;font-size:11px">hace ${formatRelativo(ultima.ts)}</span>` +
          `</div>`;
        wrap.appendChild(card);
      }

      return wrap;
    }

    //Helper compartido: card de métrica con label uppercase + valor grande
    function stat(label, val, color) {
      const d = document.createElement("div");
      d.style.cssText =
        `padding:8px 10px;background:#172029;border-radius:3px;` +
        `border-left:3px solid ${color || "#3498db"}`;
      d.innerHTML =
        `<div style="color:#7a8aa0;text-transform:uppercase;letter-spacing:0.6px;font-size:9.5px;font-weight:bold">${escapeHtml(label)}</div>` +
        `<div style="color:${color || "#e6e9ee"};font-weight:bold;font-size:16px;margin-top:3px">${escapeHtml(val)}</div>`;
      return d;
    }

    //Helper: status pill (chip uppercase con bg semi-transparente del color)
    function statusPill(label, color) {
      return `<span style="background:${color}22;color:${color};padding:3px 10px;` +
        `border-radius:11px;font-size:10.5px;text-transform:uppercase;` +
        `letter-spacing:0.8px;font-weight:bold;border:1px solid ${color}55;` +
        `display:inline-block">${escapeHtml(label)}</span>`;
    }

    //Helper: recursos con nombre + cantidad, coloreados por recurso.
    //  Madera = café, Piedra = gris, Plata = plateado. Cada recurso usa el
    //  mismo color para nombre y número.
    function recursosConIconos(w, s, i) {
      const num = (n) => Number(n || 0).toLocaleString("es-AR");
      const item = (color, nombre, valor) =>
        `<span style="color:${color}">${nombre} ${num(valor)}</span>`;
      const sep = ` <span style="color:#5a6776">·</span> `;
      return item("#a47148", "Madera", w) + sep +
        item("#9aa4b0", "Piedra", s) + sep +
        item("#c0c8d0", "Plata", i);
    }

    /**
     * Header de "ciclo" para `seccionColapsable` con layout flex (no
     * centrado). 3 zonas: título a la izquierda (flex:1), badge de ratio
     * en el medio, hora+duración a la derecha. Usado por los headers de
     * "Ciclo en curso", "Último ciclo" y "Ciclos anteriores" para que se
     * vean consistentes y los datos no compitan por el centro.
     */
    function headerCiclo({ icono, color, titulo, ratio, hora, duracion }) {
      const tituloHtml =
        `<span style="color:${color};font-weight:bold;flex:1;min-width:0;` +
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
        `${escapeHtml(icono)} ${escapeHtml(titulo)}</span>`;
      const ratioHtml = ratio
        ? `<span style="color:${color};font-weight:bold;background:${color}22;` +
          `padding:1px 8px;border-radius:3px;font-size:10.5px;flex-shrink:0">` +
          `${escapeHtml(ratio)}</span>`
        : "";
      const horaHtml = (hora || duracion)
        ? `<span style="color:#7a8aa0;font-size:10.5px;font-family:monospace;` +
          `flex-shrink:0;text-align:right">` +
          `${escapeHtml(hora || "")}${duracion ? ` · ${escapeHtml(duracion)}` : ""}` +
          `</span>`
        : "";
      return `<div style="display:flex;align-items:center;gap:10px;width:100%">` +
        tituloHtml + ratioHtml + horaHtml +
        `</div>`;
    }

    //—— Tab Settings (configuración) ——————————————————————————————————————

    function renderTabSettings(body) {
      //Sección: features globales
      body.appendChild(crearTituloSeccion("Funciones"));
      body.appendChild(crearFilaToggleFinalizar());

      //Sección: tiempo por ciudad
      body.appendChild(crearTituloSeccion("Tiempo de recolección por ciudad"));
      body.appendChild(renderTiemposPorCiudad());

      //Sección: mantenimiento (acciones destructivas)
      body.appendChild(crearTituloSeccion("Mantenimiento"));
      body.appendChild(renderMantenimiento());

      //Footer con nombre + versión
      body.appendChild(renderFooterVersion());
    }

    //Color único para todas las ciudades. Antes había una paleta cíclica
    //multicolor pero quedaba "circo" — el color por ciudad no aporta
    //información, solo confunde. Azul (#3498db = info) es coherente con
    //el resto del panel.
    const COLOR_CIUDAD = "#3498db";

    function renderTiemposPorCiudad() {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:6px";

      if (!ciudadesConAldeas.length) {
        const vacio = document.createElement("div");
        vacio.textContent = "Cargando ciudades...";
        vacio.style.cssText = "opacity:0.7;font-style:italic;padding:6px 0";
        wrap.appendChild(vacio);
        return wrap;
      }

      const ciudadesOrden = ciudadesConAldeas.slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );

      ciudadesOrden.forEach((ciudad) => {
        const det = cooldownPorCiudad[ciudad.codigoCiudad] || detectarMinutosCiudad(ciudad);
        const color = COLOR_CIUDAD;
        const minutos = det.minutos;

        const card = document.createElement("div");
        card.style.cssText =
          "display:flex;align-items:center;gap:10px;padding:8px 10px;" +
          `background:#172029;border:1px solid #2c3a4d;border-left:3px solid ${color};` +
          "border-radius:4px;transition:background 0.15s";
        card.addEventListener("mouseenter", () => card.style.background = "#1c2733");
        card.addEventListener("mouseleave", () => card.style.background = "#172029");

        //Bullet circular con el color de la ciudad — refuerza la jerarquía
        const bullet = document.createElement("div");
        bullet.style.cssText =
          `width:28px;height:28px;border-radius:50%;background:${color}22;` +
          `border:2px solid ${color};display:flex;align-items:center;justify-content:center;` +
          `flex-shrink:0;color:${color};font-weight:bold;font-size:11px`;
        //Mostramos los últimos 2 dígitos del codigoCiudad o las primeras 2
        //letras del nombre — lo que sea más identificable.
        const nombre = ciudad.nombreCiudad || String(ciudad.codigoCiudad);
        const matchNum = nombre.match(/(\d+)/);
        bullet.textContent = matchNum ? matchNum[1].slice(-2) : nombre.slice(0, 2).toUpperCase();
        card.appendChild(bullet);

        //Nombre + cantidad de aldeas
        const info = document.createElement("div");
        info.style.cssText = "flex:1;min-width:0;text-align:left";
        const nombreEl = document.createElement("div");
        nombreEl.textContent = nombre;
        nombreEl.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
        const subEl = document.createElement("div");
        subEl.textContent = `${(ciudad.aldeas || []).length} aldeas farmeables`;
        subEl.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
        info.appendChild(nombreEl);
        info.appendChild(subEl);
        card.appendChild(info);

        //Badge auto-detectado: minutos + estado de Lealtad. Reemplaza al
        //toggle 5/10 manual — la auto-detección lee `lootable_at -
        //last_looted_at` del modelo del server, que es exacto. Si la
        //ciudad no tiene claim histórico (lealtad=null, fuente=fallback)
        //mostramos el cooldown asumido en gris para que el usuario sepa
        //que se va a corregir solo al primer claim.
        const badge = document.createElement("div");
        const esFallback = det.fuente !== "auto";
        const colorBadge = esFallback ? "#5a6776" : (det.lealtad ? "#27ae60" : "#3498db");
        badge.style.cssText =
          "display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0";
        const minLine = document.createElement("div");
        minLine.textContent = `${minutos} min`;
        minLine.style.cssText =
          `padding:4px 10px;border-radius:4px;font-size:11.5px;font-weight:bold;` +
          `background:${colorBadge}22;color:${colorBadge};border:1px solid ${colorBadge}55`;
        const subBadge = document.createElement("div");
        subBadge.textContent = esFallback
          ? "sin datos aún"
          : (det.lealtad ? "Lealtad investigada" : "sin Lealtad");
        subBadge.style.cssText = `color:${colorBadge};font-size:9.5px;letter-spacing:0.3px`;
        badge.appendChild(minLine);
        badge.appendChild(subBadge);
        badge.title = esFallback
          ? "Ninguna aldea de esta ciudad tiene cooldown server registrado todavía. Se va a auto-detectar en el primer ciclo."
          : `Auto-detectado: el server reporta cooldown de ${minutos*60}s para las aldeas de esta ciudad.`;
        card.appendChild(badge);

        wrap.appendChild(card);
      });

      return wrap;
    }

    function renderMantenimiento() {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:6px";

      const mkBtn = (icono, label, sub, danger, onClick) => {
        const b = document.createElement("button");
        b.style.cssText =
          "display:flex;align-items:center;gap:10px;padding:8px 12px;" +
          `background:#172029;color:${danger ? "#e74c3c" : "#cdd5e0"};` +
          `border:1px solid ${danger ? "#5c2018" : "#2c3a4d"};` +
          "border-radius:4px;cursor:pointer;font-size:12px;text-align:left;" +
          "transition:background 0.15s,border-color 0.15s;width:100%";
        b.addEventListener("mouseenter", () => {
          b.style.background = "#1c2733";
          b.style.borderColor = danger ? "#e74c3c" : "#3498db";
        });
        b.addEventListener("mouseleave", () => {
          b.style.background = "#172029";
          b.style.borderColor = danger ? "#5c2018" : "#2c3a4d";
        });
        b.innerHTML =
          `<span style="font-size:16px;flex-shrink:0">${icono}</span>` +
          `<div style="flex:1">` +
          `<div style="font-weight:bold">${escapeHtml(label)}</div>` +
          `<div style="color:#7a8aa0;font-size:10.5px;margin-top:1px">${escapeHtml(sub)}</div>` +
          `</div>`;
        b.addEventListener("click", onClick);
        return b;
      };

      wrap.appendChild(mkBtn("📥", "Exportar historial", "Descarga un JSON con todo el historial", false, exportarHistorial));
      wrap.appendChild(mkBtn("🔄", "Reset cooldown del server", "Olvida cuándo se claimeó cada aldea — se re-sincroniza solo", false, () => {
        if (!confirm("¿Resetear el map de lastClaimAt?\nEl próximo ciclo va a respetar los cooldowns que el server marque.")) return;
        limpiarLastClaimAt();
      }));
      wrap.appendChild(mkBtn("🗑", "Limpiar historial", "Borra todos los ciclos y claims persistidos. No se puede deshacer.", true, () => {
        if (!confirm("¿Borrar todo el historial de claims y los últimos ciclos?\nEsta acción NO se puede deshacer.")) return;
        limpiarHistorial();
        renderTabActivo(document.querySelector("#panelConfigJam .pcj-body"));
      }));

      return wrap;
    }

    function renderFooterVersion() {
      const f = document.createElement("div");
      f.style.cssText =
        "margin-top:18px;padding:10px 0;border-top:1px solid #2c3a4d;" +
        "text-align:center;color:#5a6776;font-size:10.5px;letter-spacing:0.5px";
      let version = "0.0.0";
      try { version = chrome.runtime.getManifest().version; } catch (_) { /* no chrome.runtime */ }
      f.innerHTML = `<strong style="color:#7a8aa0">JamtBotGrepolis</strong> · v${escapeHtml(version)}`;
      return f;
    }

    function crearFilaToggleFinalizar() {
      const fila = document.createElement("div");
      fila.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;gap:10px;" +
        "padding:10px 12px;background:#172029;border:1px solid #2c3a4d;" +
        "border-radius:4px;margin-top:6px";

      const lblWrap = document.createElement("div");
      lblWrap.style.cssText = "flex:1;min-width:0;text-align:left";
      const lblTitulo = document.createElement("div");
      lblTitulo.textContent = "Finalizar construcción gratis";
      lblTitulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const lblSub = document.createElement("div");
      lblSub.textContent = "Activa el botón \"Gratis\" cuando faltan <5 min";
      lblSub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      lblWrap.appendChild(lblTitulo);
      lblWrap.appendChild(lblSub);
      fila.appendChild(lblWrap);

      //Toggle switch custom (más profesional que un checkbox HTML)
      const sw = document.createElement("button");
      sw.style.cssText =
        "position:relative;width:42px;height:22px;border:none;border-radius:11px;" +
        "background:#2c3a4d;cursor:pointer;transition:background 0.2s;flex-shrink:0;" +
        "padding:0;outline:none";
      const knob = document.createElement("span");
      knob.style.cssText =
        "position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;" +
        "background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3)";
      sw.appendChild(knob);
      fila.appendChild(sw);

      let estadoActual = false;
      const setEstadoVisual = (on) => {
        estadoActual = on;
        sw.style.background = on ? "#27ae60" : "#2c3a4d";
        knob.style.left = on ? "22px" : "2px";
      };

      chrome.storage.local.get("jambotConfig", (obj) => {
        const cfg = obj && obj.jambotConfig;
        const enabled =
          cfg && typeof cfg.finalizarHabilitado === "boolean"
            ? cfg.finalizarHabilitado
            : data.finalizarGratis === true;
        setEstadoVisual(enabled);
      });

      sw.addEventListener("click", () => {
        const nuevo = !estadoActual;
        setEstadoVisual(nuevo);
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfgPrev = (obj && obj.jambotConfig) || {};
          chrome.storage.local.set(
            { jambotConfig: { ...cfgPrev, finalizarHabilitado: nuevo } },
            () => {
              core.log("panel", `finalizar construcción ${nuevo ? "ON" : "OFF"}`, "ok");
            }
          );
        });
      });

      return fila;
    }

    //—— Cartel CAPTCHA ———————————————————————————————————————————————————
    //
    //Aparece arriba del tab Recolección mientras el bot está esperando que
    //el humano resuelva un CAPTCHA. Tres estados visuales:
    //  - "pending"             rojo, botón "Ya resolví" deshabilitado o
    //                          activo (depende de si el bridge ya detectó
    //                          que el captcha del juego se limpió).
    //  - "pending"+resueltoEnJuego: borde verde + badge "captcha del juego
    //                          ya resuelto", botón resaltado.
    //  - "timeout"             gris/error, sin botón "Ya resolví", solo
    //                          texto: "Iniciá manualmente para nuevo ciclo".

    function renderCartelCaptcha() {
      const wrap = document.createElement("div");
      const ctx = (core.getCaptchaContext && core.getCaptchaContext()) || {};
      const state = (core.getCaptchaState && core.getCaptchaState()) || "pending";
      const resueltoEnJuego = !!(core.isCaptchaResueltoEnJuego && core.isCaptchaResueltoEnJuego());

      const esTimeout = state === "timeout";
      const colorBorde = esTimeout ? "#7a8aa0" : (resueltoEnJuego ? "#27ae60" : "#e74c3c");
      const colorFondo = esTimeout ? "#2a2f38" : (resueltoEnJuego ? "#1f3327" : "#3a1e1e");
      wrap.style.cssText =
        `border:2px solid ${colorBorde};background:${colorFondo};` +
        "border-radius:6px;padding:14px 16px;margin-bottom:14px;" +
        "box-shadow:0 2px 8px rgba(0,0,0,0.3)";

      const titulo = document.createElement("div");
      titulo.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:10px";
      const icono = esTimeout ? "⏱" : "⚠";
      titulo.innerHTML =
        `<span style="font-size:22px">${icono}</span>` +
        `<span style="font-size:14px;font-weight:bold;color:${colorBorde};letter-spacing:0.3px">` +
        (esTimeout ? "CAPTCHA — TIMEOUT" : "CAPTCHA pendiente") +
        `</span>`;

      //Countdown del timeout (10 min). Solo en pending.
      if (!esTimeout && ctx.deteccionTs) {
        const restanteMs = Math.max(0, (ctx.deteccionTs + 10 * 60 * 1000) - Date.now());
        const txt = document.createElement("span");
        txt.style.cssText = "margin-left:auto;font-family:monospace;font-size:12px;color:#cdd5e0";
        const m = Math.floor(restanteMs / 60000);
        const s = Math.floor((restanteMs % 60000) / 1000);
        txt.textContent = `timeout en ${m}:${String(s).padStart(2, "0")}`;
        titulo.appendChild(txt);
      }
      wrap.appendChild(titulo);

      if (esTimeout) {
        const msg = document.createElement("div");
        msg.style.cssText = "font-size:12.5px;color:#cdd5e0;line-height:1.5";
        msg.textContent =
          "Pasaron 10 minutos sin que se resuelva el CAPTCHA. El bot está detenido. " +
          "Apretá Iniciar arriba para arrancar un ciclo nuevo (los cooldowns se respetan).";
        wrap.appendChild(msg);
        return wrap;
      }

      //Estado "pending" — info del fallo + botón "Ya resolví"
      const cuerpo = document.createElement("div");
      cuerpo.style.cssText = "display:flex;flex-direction:column;gap:10px";

      //Línea 1: ciclo + ciudad/aldea que falló
      if (ctx.ciclo != null && ctx.ciudad && ctx.aldea) {
        const linea = document.createElement("div");
        linea.style.cssText = "font-size:12.5px;color:#e6e9ee;line-height:1.5";
        linea.innerHTML =
          `<b>Ciclo #${ctx.ciclo}</b> · ` +
          `Ciudad <b>${escapeHtml(ctx.ciudad.nombre)}</b> → ` +
          `Aldea <b style="color:#f39c12">${escapeHtml(ctx.aldea.nombre)}</b> ` +
          `<span style="color:#7a8aa0">(id ${ctx.aldea.id})</span>`;
        cuerpo.appendChild(linea);
      }

      //Instrucción al usuario
      const instr = document.createElement("div");
      instr.style.cssText = "font-size:12px;color:#cdd5e0;line-height:1.5";
      instr.innerHTML =
        "Andá al juego, hacé click en <b>Recolectar</b> en cualquier aldea pendiente, " +
        "resolvé el CAPTCHA del juego y volvé. Da igual qué aldea recolectes — el bot " +
        "verifica el estado del server y completa lo que falte.";
      cuerpo.appendChild(instr);

      //Lista de pendientes (colapsada por default si son muchas)
      if (ctx.pendientes && ctx.pendientes.length) {
        const totalAldeas = ctx.pendientes.reduce((s, p) => s + (p.aldeas || []).length, 0);
        const det = document.createElement("details");
        det.style.cssText = "border:1px solid #2c3a4d;border-radius:4px;background:#1a232e;padding:6px 10px";
        const sum = document.createElement("summary");
        sum.style.cssText = "cursor:pointer;font-size:11.5px;color:#7a8aa0;font-weight:bold;letter-spacing:0.3px;outline:none";
        sum.textContent = `Pendientes en cola (${totalAldeas} aldeas en ${ctx.pendientes.length} ciudades)`;
        det.appendChild(sum);
        const lista = document.createElement("div");
        lista.style.cssText = "margin-top:8px;font-size:11.5px;line-height:1.6;color:#cdd5e0";
        for (const p of ctx.pendientes) {
          const l = document.createElement("div");
          l.innerHTML =
            `<b>${escapeHtml(p.ciudadNombre)}</b>: ` +
            (p.aldeas || []).map((a) => escapeHtml(a.nombre)).join(", ");
          lista.appendChild(l);
        }
        det.appendChild(lista);
        cuerpo.appendChild(det);
      }

      //Badge "bridge: captcha ya resuelto en el juego"
      if (resueltoEnJuego) {
        const ok = document.createElement("div");
        ok.style.cssText =
          "background:rgba(39,174,96,0.15);border:1px solid #27ae60;" +
          "border-radius:4px;padding:6px 10px;font-size:11.5px;color:#27ae60;font-weight:bold";
        ok.innerHTML = "✓ El CAPTCHA del juego ya está resuelto. Apretá el botón para sincronizar y reanudar.";
        cuerpo.appendChild(ok);
      }

      //Botón "Ya resolví"
      const btn = document.createElement("button");
      btn.textContent = resueltoEnJuego ? "✓ Ya resolví — sincronizar y reanudar" : "✓ Ya resolví el CAPTCHA";
      btn.style.cssText =
        `padding:10px 16px;background:${resueltoEnJuego ? "#27ae60" : "#3498db"};color:#fff;` +
        "border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px;" +
        "letter-spacing:0.3px;transition:opacity 0.15s;align-self:flex-start";
      btn.addEventListener("mouseenter", () => { btn.style.opacity = "0.85"; });
      btn.addEventListener("mouseleave", () => { btn.style.opacity = "1"; });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.style.opacity = "0.5";
        btn.textContent = "Sincronizando…";
        try {
          await resolverCaptchaPorUsuario();
        } catch (e) {
          core.logError("recoleccion", "resolverCaptchaPorUsuario falló", e);
          btn.disabled = false;
          btn.style.opacity = "1";
          btn.textContent = resueltoEnJuego ? "✓ Ya resolví — sincronizar y reanudar" : "✓ Ya resolví el CAPTCHA";
        }
      });
      cuerpo.appendChild(btn);

      wrap.appendChild(cuerpo);
      return wrap;
    }

    //—— Tab Recolección ——————————————————————————————————————————————————

    function renderTabRecoleccion(body) {
      body.innerHTML = "";

      //Cartel CAPTCHA — pinned en el tope cuando hay captcha activo (o en
      //timeout). Es la pieza más importante del tab mientras el bot está
      //esperando al humano: dice qué pasó, qué aldea/ciudad disparó el
      //captcha, cuántas aldeas quedaron en cola y cuánto falta para el
      //timeout. Botón "Ya resolví" gatilla la sincronización del server.
      if (core.isCaptchaActive && core.isCaptchaActive()) {
        body.appendChild(renderCartelCaptcha());
      }

      //Sección 1: ciclo en curso (si lo hay) — colapsable, abierto por default
      if (cicloActual) {
        body.appendChild(seccionColapsable(
          headerCiclo({
            icono: "↻",
            color: "#f39c12",
            titulo: `Ciclo #${cicloActual.n} en curso`,
            ratio: `${cicloActual.aldeasCompletadas}/${cicloActual.totalAldeas} aldeas`,
            //sin hora — no tiene sentido aún (no terminó)
          }),
          uiColapso.ciclos.actual,
          (v) => uiColapso.ciclos.actual = v,
          () => renderResumenCiclo(cicloActual, true),
          "#f39c12"
        ));
      }

      //Sección 2: último ciclo terminado (último elemento de ciclos[])
      const ultimoCiclo = ciclos.length ? ciclos[ciclos.length - 1] : null;
      if (ultimoCiclo) {
        const total = (ultimoCiclo.totalAldeas != null) ? ultimoCiclo.totalAldeas
          : Object.values(ultimoCiclo.ciudades || {}).reduce((s, c) => s + (c.esperado || 6), 0);
        const claims = Object.values(ultimoCiclo.ciudades || {}).reduce((s, c) => s + (c.claims || 0), 0);
        const completo = claims === total;
        //Ciclos interrumpidos (recuperados del storage tras un corte) se
        //marcan amarillos: no son un fail real, pero tampoco un ciclo
        //completo — el corte sucedió por causas externas (reload, F5).
        const interrumpido = ultimoCiclo.interrumpido === true;
        const icono = interrumpido ? "⚠" : (completo ? "✓" : "✗");
        const color = interrumpido ? "#f39c12" : (completo ? "#27ae60" : "#e74c3c");
        const tituloSufijo = interrumpido ? " (interrumpido)" : "";
        body.appendChild(seccionColapsable(
          headerCiclo({
            icono,
            color,
            titulo: `Último ciclo #${ultimoCiclo.n}${tituloSufijo}`,
            ratio: `${claims}/${total} aldeas`,
            hora: formatHoraCorta(ultimoCiclo.fin),
            duracion: core.formatDuracion((ultimoCiclo.duracion || 0) / 1000),
          }),
          uiColapso.ciclos.ultimo,
          (v) => uiColapso.ciclos.ultimo = v,
          () => renderResumenCiclo(ultimoCiclo, false),
          color
        ));
      }

      //Sección 3: ciclos anteriores (todos menos el último). Cada uno es
      //una tarjeta colapsable con el mismo formato que "Último ciclo".
      const anteriores = ciclos.slice(0, -1).reverse(); //más reciente primero
      if (anteriores.length) {
        body.appendChild(seccionColapsable(
          `📜  Ciclos anteriores  (${anteriores.length})`,
          uiColapso.ciclosAnteriores === true,
          (v) => uiColapso.ciclosAnteriores = v,
          () => renderListaCiclosAnteriores(anteriores),
          "#8a96a6"
        ));
      }

      if (!cicloActual && !ultimoCiclo) {
        const vacio = document.createElement("div");
        vacio.textContent = "Todavía no se ejecutó ningún ciclo en esta sesión.";
        vacio.style.cssText = "opacity:0.7;padding:8px 0";
        body.appendChild(vacio);
      }

      //Sección 3: errores recientes
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

      //Header de estado de la feature — 2 cards lado a lado
      const headerWrap = document.createElement("div");
      headerWrap.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px";

      const estadoColor = !ds.habilitada ? "#7a8aa0" : (core.isPaused() ? "#27ae60" : "#3498db");
      const estadoTxt = !ds.habilitada ? "Deshabilitada"
        : core.isPaused() ? "Pausada"
        : "Activa";
      const estadoSub = !ds.habilitada ? "Activar en Settings"
        : core.isPaused() ? "Bot global pausado"
        : "";

      const card1 = document.createElement("div");
      card1.style.cssText =
        `padding:7px 10px;background:#172029;border-radius:3px;border-left:3px solid ${estadoColor}`;
      card1.innerHTML =
        `<div style="color:#7a8aa0;text-transform:uppercase;letter-spacing:0.6px;font-size:9.5px;font-weight:bold">Estado</div>` +
        `<div style="color:${estadoColor};font-weight:bold;font-size:14px;margin-top:2px">${estadoTxt}</div>` +
        (estadoSub ? `<div style="color:#7a8aa0;font-size:10px;margin-top:1px">${estadoSub}</div>` : "");
      headerWrap.appendChild(card1);

      let proximoTxt = "—";
      if (ds.proximoTickAt) {
        const seg = Math.max(0, Math.round((ds.proximoTickAt - Date.now()) / 1000));
        proximoTxt = core.formatDuracion(seg);
      }
      const card2 = document.createElement("div");
      card2.style.cssText =
        "padding:7px 10px;background:#172029;border-radius:3px;border-left:3px solid #3498db";
      card2.innerHTML =
        `<div style="color:#7a8aa0;text-transform:uppercase;letter-spacing:0.6px;font-size:9.5px;font-weight:bold">Próximo tick</div>` +
        `<div style="color:#cdd5e0;font-weight:bold;font-size:14px;margin-top:2px">${proximoTxt}</div>`;
      headerWrap.appendChild(card2);

      body.appendChild(headerWrap);

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
      wrap.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px 0";
      const stat = (label, val, color) => {
        const d = document.createElement("div");
        d.style.cssText =
          "padding:7px 10px;background:#172029;border-radius:3px;border-left:3px solid " +
          (color || "#3498db");
        d.innerHTML =
          `<div style="color:#7a8aa0;text-transform:uppercase;letter-spacing:0.6px;font-size:9.5px;font-weight:bold">${label}</div>` +
          `<div style="color:${color || "#e6e9ee"};font-weight:bold;font-size:14px;margin-top:2px">${val}</div>`;
        return d;
      };
      wrap.appendChild(stat("Órdenes en cola", u.ordenesEnCola));
      wrap.appendChild(stat("En ventana free", u.ordenesEnVentana, u.ordenesEnVentana ? "#f39c12" : null));
      wrap.appendChild(stat("Finalizadas", u.finalizadas, u.finalizadas ? "#27ae60" : null));
      wrap.appendChild(stat("Duración", core.formatDuracion((u.duracion || 0) / 1000)));
      if (u.captchaDurante) {
        const captchaBox = stat("CAPTCHA durante el ciclo", "Sí", "#e74c3c");
        captchaBox.style.gridColumn = "1 / -1";
        wrap.appendChild(captchaBox);
      }
      return wrap;
    }

    function renderColaConstr(cola) {
      const wrap = document.createElement("div");
      if (!cola.length) {
        const v = document.createElement("div");
        v.textContent = "(no hay órdenes en cola)";
        v.style.cssText = "opacity:0.6;font-style:italic;padding:6px 0;font-size:11px";
        wrap.appendChild(v);
        return wrap;
      }
      const ahora = Math.floor(Date.now() / 1000);
      for (const o of cola) {
        const restante = Math.max(0, o.finish_time - ahora);
        const enVentana = restante <= VENTANA_SEGUNDOS_DEFAULT;
        const color = enVentana ? "#f39c12" : "#7a8aa0";

        const fila = document.createElement("div");
        fila.className = "pcj-row";
        fila.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:5px 8px;margin:2px 0;" +
          "background:#172029;border-radius:3px;border-left:3px solid " + color;

        const badge = document.createElement("span");
        badge.style.cssText =
          `display:inline-flex;align-items:center;justify-content:center;` +
          `width:20px;height:20px;background:${color}22;color:${color};` +
          `border-radius:3px;font-weight:bold;font-size:11px;flex-shrink:0`;
        badge.textContent = enVentana ? "⏱" : "·";
        fila.appendChild(badge);

        const ciudad = document.createElement("span");
        ciudad.textContent = o.town_nombre;
        ciudad.style.cssText = "flex:1;color:#e6e9ee;font-size:11.5px;font-weight:bold";
        fila.appendChild(ciudad);

        const tipo = document.createElement("span");
        tipo.textContent = o.building_type;
        tipo.style.cssText = "flex:1;color:#7a8aa0;font-family:monospace;font-size:10.5px";
        fila.appendChild(tipo);

        const tiempo = document.createElement("span");
        tiempo.textContent = core.formatDuracion(restante);
        tiempo.style.cssText =
          `color:${color};min-width:75px;text-align:right;font-weight:bold;font-size:11px`;
        fila.appendChild(tiempo);

        wrap.appendChild(fila);
      }
      return wrap;
    }

    function renderFinalizadasConstr(finalizadas) {
      const wrap = document.createElement("div");
      if (!finalizadas.length) {
        const v = document.createElement("div");
        v.textContent = "(todavía no se finalizó ninguna en esta sesión)";
        v.style.cssText = "opacity:0.6;font-style:italic;padding:6px 0;font-size:11px";
        wrap.appendChild(v);
        return wrap;
      }
      for (const f of finalizadas) {
        const fila = document.createElement("div");
        fila.className = "pcj-row";
        fila.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:5px 8px;margin:2px 0;" +
          "background:#172029;border-radius:3px;border-left:3px solid #27ae60";
        fila.innerHTML =
          `<span style="color:#27ae60;min-width:18px;text-align:center">✓</span>` +
          `<span style="color:#7a8aa0;min-width:42px;font-family:monospace;font-size:10.5px">${formatHoraCorta(f.ts)}</span>` +
          `<span style="flex:1;color:#e6e9ee;font-weight:bold;font-size:11.5px">${escapeHtml(f.town_nombre || f.town_id)}</span>` +
          `<span style="flex:1;color:#7a8aa0;font-family:monospace;font-size:10.5px">${escapeHtml(f.building_type)}</span>` +
          `<span style="color:#5a6776;font-size:10px">#${f.id}</span>`;
        wrap.appendChild(fila);
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
      //Estilo "label" tipo dashboard: chico, uppercase con tracking, color
      //gris medio. Mucho más profesional que el "centrado bold" anterior.
      t.style.cssText =
        "font-size:10.5px;font-weight:bold;margin:14px 0 8px;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px;text-align:left";
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
      txt.style.cssText = "flex:1;text-align:left";
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

    function renderListaCiclosAnteriores(anteriores) {
      const wrap = document.createElement("div");
      //Estado de colapso por ciclo. Los anteriores arrancan TODOS cerrados
      //por default — el usuario expande los que le interesan.
      uiColapso.cicloPorN = uiColapso.cicloPorN || {};
      for (const c of anteriores) {
        const total = (c.totalAldeas != null) ? c.totalAldeas
          : Object.values(c.ciudades || {}).reduce((s, x) => s + (x.esperado || 6), 0);
        const claims = Object.values(c.ciudades || {}).reduce((s, x) => s + (x.claims || 0), 0);
        const completo = claims === total;
        const interrumpido = c.interrumpido === true;
        const icono = interrumpido ? "⚠" : (completo ? "✓" : "✗");
        const color = interrumpido ? "#f39c12" : (completo ? "#27ae60" : "#e74c3c");
        const tituloSufijo = interrumpido ? " (interrumpido)" : "";
        wrap.appendChild(seccionColapsable(
          headerCiclo({
            icono,
            color,
            titulo: `Ciclo #${c.n}${tituloSufijo}`,
            ratio: `${claims}/${total} aldeas`,
            hora: formatHoraCorta(c.fin),
            duracion: core.formatDuracion((c.duracion || 0) / 1000),
          }),
          uiColapso.cicloPorN[c.n] === true,
          (v) => uiColapso.cicloPorN[c.n] = v,
          () => renderResumenCiclo(c, false),
          color
        ));
      }
      return wrap;
    }

    function renderResumenCiclo(ciclo, enCurso) {
      const wrap = document.createElement("div");
      const ciudadesArr = Object.entries(ciclo.ciudades || {})
        .map(([id, c]) => ({ id, ...c }))
        .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", undefined, { numeric: true }));
      uiColapso.cicloCiudades[ciclo.n] = uiColapso.cicloCiudades[ciclo.n] || {};
      for (const c of ciudadesArr) {
        const completa = c.claims >= (c.esperado || 6);
        const enProgreso = enCurso && c.claims < (c.esperado || 6);
        const sinClaims = enCurso && c.claims === 0;
        const color = sinClaims ? "#7a8aa0" : enProgreso ? "#f39c12" : completa ? "#27ae60" : "#e74c3c";
        const icon = sinClaims ? "·" : enProgreso ? "↻" : completa ? "✓" : "✗";

        //Header HTML que replica la fila plana anterior: badge + nombre +
        //ratio + recursos. seccionColapsable agrega su propio arrow.
        const headerTxt =
          `<div style="display:flex;align-items:center;gap:8px;width:100%">` +
          `  <span style="display:inline-flex;align-items:center;justify-content:center;` +
          `width:20px;height:20px;background:${color}22;color:${color};` +
          `border-radius:3px;font-weight:bold;font-size:12px;flex-shrink:0">${icon}</span>` +
          `  <span style="flex:1;font-size:12px;color:#e6e9ee;text-align:left">${escapeHtml(c.nombre)}</span>` +
          `  <span style="color:${color};font-weight:bold;font-size:11.5px;min-width:30px;text-align:right">${c.claims}/${c.esperado || 6}</span>` +
          `  <span style="color:#7a8aa0;font-family:monospace;font-size:10.5px;min-width:140px;text-align:right">+${c.wood} / +${c.stone} / +${c.iron}</span>` +
          `</div>`;

        //Lookup de las aldeas estáticas de la ciudad para mostrar el
        //historial al expandir. Si la ciudad ya no existe en memoria
        //(p.ej. ciclo viejo de antes de un reload), mostramos un placeholder.
        const ciudadFull = ciudadesConAldeas.find(
          (x) => String(x.codigoCiudad) === String(c.id)
        );
        const aldeasOrden = ciudadFull
          ? (ciudadFull.aldeas || []).slice().sort((a, b) =>
              (a.name || "").localeCompare(b.name || "", undefined, { numeric: true })
            )
          : [];

        wrap.appendChild(seccionColapsable(
          headerTxt,
          uiColapso.cicloCiudades[ciclo.n][c.id] === true,
          (v) => uiColapso.cicloCiudades[ciclo.n][c.id] = v,
          () => aldeasOrden.length
            ? renderAldeasDeCiudad(aldeasOrden, ciclo.n)
            : (() => {
                const v = document.createElement("div");
                v.textContent = "(aldeas no disponibles — ciudad ya no está cargada)";
                v.style.cssText = "opacity:0.6;font-style:italic;padding:4px 0";
                return v;
              })(),
          color
        ));
      }
      if (!enCurso && ciclo.duracion != null) {
        const totWood = ciudadesArr.reduce((s, c) => s + (c.wood || 0), 0);
        const totStone = ciudadesArr.reduce((s, c) => s + (c.stone || 0), 0);
        const totIron = ciudadesArr.reduce((s, c) => s + (c.iron || 0), 0);
        const totales = document.createElement("div");
        totales.style.cssText =
          "margin-top:8px;padding:6px 8px;background:#0f1620;border-radius:3px;" +
          "font-size:11px;color:#cdd5e0;display:flex;justify-content:space-between";
        totales.innerHTML =
          `<span style="color:#7a8aa0;text-transform:uppercase;letter-spacing:0.8px;font-size:10px;font-weight:bold">Total ciclo</span>` +
          `<span style="font-family:monospace;color:#27ae60">+${totWood} mad · +${totStone} pie · +${totIron} pla</span>`;
        wrap.appendChild(totales);
      }
      return wrap;
    }

    //Mapa central de presentación de status. Devuelve {label, color, icono}
    //para cada uno de los 4 valores que retorna recolectarAldea (más null
    //cuando no hay historial). Centralizar acá evita texto críptico tipo
    //"saltada-cooldown" suelto en la UI.
    function presentarStatus(status) {
      switch (status) {
        case "ok":               return { label: "OK",          color: "#27ae60", icono: "✓" };
        case "reintentar":       return { label: "Pendiente",   color: "#f39c12", icono: "↻" };
        case "descartar":        return { label: "Descartada",  color: "#e74c3c", icono: "✗" };
        case "saltada-cooldown": return { label: "En cooldown", color: "#8a96a6", icono: "⏱" };
        case "no-pertenece":     return { label: "Sin acceso",  color: "#8a96a6", icono: "⊘" };
        default:                 return { label: "—",           color: "#8a96a6", icono: "·" };
      }
    }

    function renderAldeasDeCiudad(aldeas, cicloN) {
      //Cuando se renderiza dentro de un ciclo concreto (cicloN definido), el
      //status de cada aldea sale del historial filtrado a ese ciclo — no del
      //último entry global. Sin esto, las aldeas de un ciclo en curso
      //heredaban el "OK" del ciclo anterior antes de ser procesadas.
      const wrap = document.createElement("div");
      for (const aldea of aldeas) {
        const histo = historialPorAldea[aldea.id] || [];
        const ultimaOk = [...histo].reverse().find((e) => e.status === "ok");
        const desde = ultimaOk ? formatRelativo(ultimaOk.ts) : "—";
        const entradaCiclo = cicloN != null
          ? [...histo].reverse().find((e) => e.ciclo === cicloN)
          : histo[histo.length - 1];
        const p = presentarStatus(entradaCiclo && entradaCiclo.status);
        //Layout: status (badge) a la izquierda · nombre + hace-tiempo debajo
        const headerTxt =
          `<div style="display:flex;align-items:center;gap:10px;width:100%">` +
          `  <span style="color:${p.color};font-weight:bold;font-size:11px;min-width:62px;flex-shrink:0">${p.icono} ${escapeHtml(p.label)}</span>` +
          `  <div style="flex:1;line-height:1.25;min-width:0">` +
          `    <div style="color:#e6e9ee">${escapeHtml(aldea.name || `id ${aldea.id}`)}</div>` +
          `    <div style="color:#7a8aa0;font-size:9.5px;margin-top:1px">hace ${escapeHtml(desde)}</div>` +
          `  </div>` +
          `</div>`;
        wrap.appendChild(seccionColapsable(
          headerTxt,
          uiColapso.aldeas[aldea.id] === true,
          (v) => uiColapso.aldeas[aldea.id] = v,
          () => renderHistorialAldea(aldea),
          p.color
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
          "display:flex;gap:8px;padding:3px 4px;border-bottom:1px solid #1a232e;align-items:center";
        const p = presentarStatus(e.status);
        const cuerpo =
          e.status === "ok" && e.dW != null
            ? `${fmt(e.dW)}/${fmt(e.dS)}/${fmt(e.dI)}`
            : e.status === "saltada-cooldown"
            ? (e.esperaSeg ? `falta ${core.formatDuracion(e.esperaSeg)}` : "cooldown")
            : e.errorMsg || p.label;
        fila.innerHTML =
          `<span style="color:#7a8aa0;min-width:42px">${formatHoraCorta(e.ts)}</span>` +
          `<span style="color:${p.color};min-width:14px;text-align:center">${p.icono}</span>` +
          `<span style="flex:1;color:${p.color}">${escapeHtml(cuerpo)}</span>` +
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


    //Reflejar cambios de CAPTCHA en el botón. Cuando se resuelve, volver
    //al estado anterior según core.isPaused().
    core.onCaptcha((active) => {
      actualizarEstadoCard();
      void active;
    });

    //Repintar UI cuando cambia el contexto del CAPTCHA — el bridge avisó
    //"resueltoEnJuego" o el timeout disparó. La card del pulpo y el cartel
    //grande del tab Recolección leen de core.getCaptchaContext / state.
    if (core.onCaptchaContextChange) {
      core.onCaptchaContextChange(() => {
        actualizarEstadoCard();
        const panel = document.getElementById("panelConfigJam");
        if (panel && panel.style.display !== "none") {
          actualizarHeaderPanel(panel);
          if (tabActivo === "recoleccion") {
            const body = panel.querySelector(".pcj-body");
            if (body) renderTabRecoleccion(body);
          }
        }
      });
    }

    //Si el CAPTCHA timeoutea (10 min sin click), pausar el bot. El próximo
    //Iniciar arranca un ciclo limpio (recolectarRecursos resetea estado).
    if (core.onCaptchaTimeout) {
      core.onCaptchaTimeout(() => {
        if (!core.isPaused()) core.setPaused(true);
      });
    }

    //—— Sincronización post-CAPTCHA ——————————————————————————————————————
    //
    //Cuando el usuario aprieta "Ya resolví", refrescamos el estado real
    //del server para detectar qué aldeas fue claimeando el humano mientras
    //el bot estaba en pausa por CAPTCHA.
    //
    //Estrategia: cada aldea trae `loot` (timestamp Unix sec del próximo
    //claim disponible). Si después del CAPTCHA `loot > now`, esa aldea
    //tiene un cooldown vivo. Comparamos contra `lastClaimAtPorAldea`:
    //  - si nuestro lastClaimAt + cooldown ≈ loot*1000  → ya la claimeó
    //    el bot, el `loot` corresponde al claim que ya teníamos registrado.
    //    No hacemos nada.
    //  - si NO coinciden (o no teníamos lastClaimAt para esa aldea) →
    //    el HUMANO la claimeó. Inferimos cuándo fue el claim a partir de
    //    `loot` y el cooldown configurado, y seteamos lastClaimAtPorAldea.
    //
    //Eso sincroniza los "gaps" que pidió el usuario: si el humano claimeó
    //3 aldeas con varios minutos de diferencia, cada una termina con su
    //propio lastClaimAt correcto, y el próximo ciclo respeta cada cooldown
    //sin pegarle al server antes de tiempo.

    async function refrescarAldeasCiudad(codigoCiudad, islandId) {
      try {
        let res = await fetch(
          `https://${world_id}.grepolis.com/game/island_info?town_id=${codigoCiudad}&action=index&h=${csrfToken}&json={"island_id":${islandId},"fetch_tmpl":1,"town_id":${codigoCiudad},"nl_init":true}`,
          { method: "GET", headers: { "X-Requested-With": "XMLHttpRequest", accept: "text/plain, */*; q=0.01" } }
        );
        res = await res.json();
        return (res && res.json && res.json.json && res.json.json.farm_town_list) || null;
      } catch (e) {
        core.logError("recoleccion", `refrescarAldeasCiudad falló (ciudad=${codigoCiudad})`, e);
        return null;
      }
    }

    /**
     * Refresca cada ciudad del jugador y reconcilia `lastClaimAtPorAldea`
     * con los `loot` actuales del server. Devuelve un resumen
     * { humanoClaimeo: number, totalAldeas: number }.
     */
    async function sincronizarPostCaptcha() {
      core.log("recoleccion", "sincronizando estado del server post-CAPTCHA…");
      let humanoClaimeo = 0;
      let totalAldeas = 0;
      const ahoraSec = Math.floor(Date.now() / 1000);
      //Margen de tolerancia para "matchea con un claim del bot ya
      //registrado": ±90s cubre drift de reloj cliente/server, latencia, y
      //jitter del setTimeout. Si la diferencia entre el loot inferido y el
      //loot real es <90s, asumimos que es el mismo claim.
      const TOLERANCIA_SEG = 90;
      for (const ciudad of ciudadesConAldeas) {
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        const cooldownMs = cfg.minutos * 60 * 1000;
        //Necesitamos islandId para refrescar — lo guardamos en
        //ciudad.islandId si está; si no, salteamos esa ciudad.
        const islandId = ciudad.islandId;
        if (islandId == null) continue;
        const aldeasFresco = await refrescarAldeasCiudad(ciudad.codigoCiudad, islandId);
        if (!Array.isArray(aldeasFresco)) continue;
        //Actualizar la lista en memoria con los loot nuevos.
        ciudad.aldeas = aldeasFresco;
        for (const a of aldeasFresco) {
          totalAldeas += 1;
          if (!a || !a.id || !a.loot) continue;
          if (a.loot <= ahoraSec) continue; //sin cooldown vivo, no fue claimeada recientemente
          const lootMs = a.loot * 1000;
          const lastBot = lastClaimAtPorAldea[a.id] || 0;
          const lootEsperadoBot = lastBot ? lastBot + cooldownMs : 0;
          const diffSeg = Math.abs((lootMs - lootEsperadoBot) / 1000);
          if (lastBot && diffSeg <= TOLERANCIA_SEG) {
            //Coincide con el claim del bot — nada que hacer.
            continue;
          }
          //Humano claimeó. Inferimos el ts del claim: loot - cooldown.
          const claimInferidoMs = lootMs - cooldownMs;
          lastClaimAtPorAldea[a.id] = claimInferidoMs;
          humanoClaimeo += 1;
          core.log(
            "recoleccion",
            `  ▸ ${ciudad.nombreCiudad || ciudad.codigoCiudad} ← ${a.name || `farm_${a.id}`} (id ${a.id}): claim del HUMANO hace ${core.formatDuracion((Date.now() - claimInferidoMs) / 1000)}`,
            "ok"
          );
        }
        await delayMs(200); //pequeño espaciado entre ciudades
      }
      guardarLastClaimAt();
      core.log(
        "recoleccion",
        `sincronización OK · humano claimeó ${humanoClaimeo}/${totalAldeas} aldea(s)`,
        "ok"
      );
      return { humanoClaimeo, totalAldeas };
    }

    /**
     * Lo llama el botón "Ya resolví" del cartel. Hace la sincro y, si todo
     * salió bien, cierra el estado de captcha en el core y reanuda el ciclo
     * (tick inmediato con margen pequeño).
     */
    async function resolverCaptchaPorUsuario() {
      if (!core.isCaptchaActive()) return;
      try {
        await sincronizarPostCaptcha();
      } catch (e) {
        core.logError("recoleccion", "sincronización post-CAPTCHA falló", e);
        //Aun si la sincro falla, dejamos al usuario reanudar — quizá el
        //humano claimeó manual y los próximos ciclos se autocorregirán.
      }
      core.onCaptchaResuelto();
      //Tick inmediato (con jitter mínimo) para procesar lo que quedó del
      //ciclo. recolectarRecursos chequea isPaused/isCaptchaActive al
      //arranque, así que no hay riesgo de re-disparar si el captcha sigue.
      if (!core.isPaused()) {
        programarSiguienteTick(jitter(1500, 3000));
      }
    }

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
      actualizarEstadoCard();

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
        //Timestamp del último claim ok dentro del ciclo. Lo usamos para
        //estimar el `fin` cuando el ciclo se recupera del storage tras una
        //interrupción (extensión recargada, F5 a media tanda, etc). Sin
        //esto el ciclo recuperado mostraría duracion=0 o duracion absurda.
        ultimoClaimAt: null,
      };
      actualizarIndicadorVivo();
      //Persistir el ciclo recién creado ANTES del primer claim. Si la pestaña
      //se cierra entre acá y el primer registrarClaim el storage queda con
      //un ciclo vacío en curso que el bootstrap descarta (aldeasCompletadas=0).
      guardarHistorial();

      const stats = await recolectarCiudades();
      const duracionCiclo = Date.now() - inicioCiclo;

      //Promover cicloActual → ciclos[] (FIFO, cap CICLOS_MAX) y persistir.
      //Usamos la versión async + await porque si recargás la pestaña justo
      //después de terminar un ciclo, queremos que el push esté en disco
      //antes de seguir. Antes era fire-and-forget y se perdía el ciclo en
      //la ventana de ~10-50ms hasta que chrome.storage.local.set completa.
      if (cicloActual) {
        cicloActual.fin = Date.now();
        cicloActual.duracion = duracionCiclo;
        cicloActual.captchaDurante = core.isCaptchaActive();
        ciclos.push(cicloActual);
        while (ciclos.length > CICLOS_MAX) ciclos.shift();
        cicloActual = null;
        await guardarHistorialAsync();
        actualizarIndicadorVivo();
      }

      //Si el usuario pausó durante el ciclo, no programamos el siguiente.
      if (core.isPaused()) return;

      //CAPTCHA pendiente → NO programamos siguiente tick. El bot queda
      //esperando al humano; cuando aprieta "Ya resolví" la sincronización
      //llama a programarSiguienteTick(0) para retomar el ciclo. Si pasan
      //10 min sin click, el listener de onCaptchaTimeout pausa todo.
      if (core.isCaptchaActive()) {
        core.log(
          "recoleccion",
          `ciclo #${nCiclo} interrumpido por CAPTCHA · duró ${core.formatDuracion(duracionCiclo / 1000)} · esperando al humano`,
          "warn"
        );
        actualizarEstadoCard();
        return;
      }

      //Espera = max(baseMs - duracionCiclo + 30s, 5s).
      //
      //Anclamos al INICIO del ciclo: queremos que el ciclo siguiente arranque
      //(en promedio) a `baseMs + 30s` desde el inicio del actual, así CADA
      //aldea — sin importar su posición — tiene su CD completo + 30s de
      //margen cuando se la vuelve a claimear en la misma posición del ciclo
      //siguiente.
      //
      //Por qué el +30s de gracia es seguro pese a la varianza del jitter:
      //  - jitter aldea-aldea ahora es [0, 500ms]. La diferencia entre dos
      //    sorteos es uniforme [-500ms, +500ms] con σ_per_gap ≈ 0.2s.
      //  - Para N aldeas la varianza acumulada es σ_total ≈ 0.2·√N segundos
      //    (teorema central del límite — la varianza escala con √N, no con N).
      //  - 100 ciudades = 600 aldeas → σ_total ≈ 4.9s → 30s cubre 6.1σ.
      //  - 50 ciudades  = 300 aldeas → σ_total ≈ 3.5s → 30s cubre 8.6σ.
      //  - 3 ciudades   = 18 aldeas  → σ_total ≈ 0.85s → 30s cubre 35σ.
      //  - Probabilidad de rechazo del server (5σ) ≈ 1 en 3.5 millones.
      //
      //Por qué la versión vieja (`baseMs - duracionCiclo + jitter(3-30s)`)
      //rompía: con jitter 2-2.5s y N=18, σ_total era 0.85s, pero el jitter
      //mínimo de 3s NO cubría el peor caso adversarial -8.5s (cuando los
      //draws maximalmente desfavorables se alineaban). Con jitter ≤500ms el
      //peor caso adversarial es de orden √N · 0.2s, que 30s sobrecubre.
      //
      //Trade-off: el loop completo es `duracionCiclo + max(baseMs -
      //duracionCiclo + 30s, 5s) ≈ baseMs + 30s` (mientras duracionCiclo <
      //baseMs - 30s). Yield/aldea ≈ 5.71/h vs ideal teórico 6.0/h (-4.8%).
      //Independiente de N hasta el bot-bound regime.
      //
      //PISO de 5s: cuando duracionCiclo > baseMs (≥130 ciudades aprox), el
      //ciclo en sí ya ocupa todo el cooldown y la espera tendería a 0/negativa.
      //El piso de 5s da un respiro mínimo entre vueltas para que el server
      //digiera el último claim y para mantener algo de variabilidad anti-bot.
      //
      //Base = mínimo de tiempos configurados (5 o 10). Si todas las
      //ciudades están en 10min, el ciclo tickea cada 10 — no nos
      //despertamos cada 5min para no hacer nada.
      const GRACIA_MS = 30 * 1000;
      const PISO_ESPERA_MS = 5 * 1000;
      const baseMs = tiempoCicloMinutos() * 60 * 1000;
      const esperaNormal = Math.max(baseMs - duracionCiclo + GRACIA_MS, PISO_ESPERA_MS);
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
      //Piso 5s: igual que en esperaNormal, mantenemos un respiro mínimo entre
      //vueltas para que el server termine de procesar el último claim y para
      //no spammear si hay timing extraño. Antes el piso era 30s, pensado para
      //la era pre-fire-and-forget: ahora la última aldea SIEMPRE se awaitea
      //(ver pass 2 en recolectarCiudades), así que cuando esto ejecuta el
      //server YA confirmó el último claim y 5s alcanza.
      const tiempoEspera = Math.max(PISO_ESPERA_MS, esperaAjustada);

      core.log(
        "recoleccion",
        `ciclo #${nCiclo} OK · duró ${core.formatDuracion(duracionCiclo / 1000)} · próximo en ${core.formatDuracion(tiempoEspera / 1000)}`,
        "ok"
      );

      //Warning si el ciclo se está acercando al cooldown — a partir del 70%
      //hay riesgo de chocar con el cooldown del server cuando una ciudad
      //procesada al final del ciclo aparezca al principio del siguiente.
      //Antes la salida era "subí ciudades a 10min en el panel"; ahora el
      //cooldown se auto-detecta del server, así que el remedio es investigar
      //"Lealtad de los aldeanos" en las ciudades de 5min para que pasen a
      //10min — o si ya está, reducir cantidad de ciudades por bot.
      if (duracionCiclo > baseMs * 0.7) {
        const pct = Math.round((duracionCiclo / baseMs) * 100);
        core.logWarn(
          "recoleccion",
          `ciclo (${core.formatDuracion(duracionCiclo / 1000)}) ocupa el ${pct}% del cooldown (${core.formatDuracion(baseMs / 1000)}). Riesgo de rechazo del server — investigá "Lealtad de los aldeanos" en las ciudades de 5min para subirlas a 10min.`
        );
      }

      actualizarEstadoCard();
      programarSiguienteTick(tiempoEspera);

      //Refresh auto-detección del cooldown si quedó alguna ciudad sin
      //datos (típicamente: ciudad recién fundada que ahora ya tuvo su
      //primer claim). Lo dejamos al final, sin await — el siguiente tick
      //ya está programado.
      if (hayCiudadesEnFallback()) {
        refrescarCooldownsAuto();
      }
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

      //Orden de ciudades: alfabético-natural por nombre (001 Jam < 002 Jam
      //< 010 Jam). Determinista — necesario para que la fórmula de
      //esperaNormal funcione (cada aldea está en la misma posición temporal
      //del ciclo en cada vuelta, ver el bloque "Orden DETERMINISTA" más abajo).
      //
      //El cooldown gating se hace por ALDEA en el Pass 1 de abajo. Antes era
      //por ciudad y eso perdía aldeas cuando el CAPTCHA cortaba un ciclo a
      //mitad: la ciudad quedaba marcada como "ya procesada" aunque le
      //faltaran aldeas. Ahora cada aldea respeta su propio cooldown server,
      //así que las pendientes se retoman en el próximo ciclo sin esperar 10min.
      const ciudadesOrdenadas = ciudadesConAldeas.slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );
      //cicloState.proximaLiberacionSeg agrega el mínimo de "cuándo se libera
      //la próxima aldea" entre TODAS las ciudades. Se actualiza en Pass 1
      //cuando una aldea queda saltada por cooldown. Lo usamos al final para
      //reprogramar el próximo tick si es antes del intervalo normal — evita
      //perder yield después de un reload.
      const cicloState = { proximaLiberacionSeg: Infinity };
      //Lista de aldeas para reintentar al final del ciclo. Se popula en los
      //handlers de respuesta cuando el server rechaza (success:false) o el
      //fetch tira un error transitorio (timeout, abort, network).
      const pendientes = [];

      //Contadores por ciudad para el resumen final:
      //  claims               aldeas claimeadas con éxito en este ciclo
      //  saltadasCooldown     aldeas en cooldown vivo (cliente o server) — esperado, no es error
      //  descartadasOtras     errores no recuperables: recursosLlenos, sin relation_id, sin Town/CAPTCHA
      //  reintentadasFallidas success=false que tras 3 intentos siguen fallando
      //  bloqueadas           aldeas que el server reporta como "no te pertenece" — la ciudad
      //                       todavía no las desbloqueó (típico en ciudades recién fundadas con
      //                       <6 aldeas vasallas conquistadas). No es error: se descuentan del
      //                       total esperado para no marcar la tanda como incompleta.
      //
      //"tanda incompleta" (rojo) solo si claims+saltadasCooldown < (6 - bloqueadas) — o sea,
      //si hubo descartes o reintentos agotados. Si todas las que faltaron
      //estaban en cooldown legítimo o sin acceso, la tanda es OK (verde).
      for (const ciudad of ciudadesOrdenadas) {
        acumuladoCiclo[ciudad.codigoCiudad] = {
          wood: 0, stone: 0, iron: 0, claims: 0,
          saltadasCooldown: 0,
          descartadasOtras: 0,
          reintentadasFallidas: 0,
          bloqueadas: 0,
        };
      }

      //═══ Pass 1: cooldown gating + build flat task list ═══
      //
      //Sincronía pura: filtra aldeas en cooldown vivo (cliente o server) y
      //arma `tareas[]` con (ciudad, aldea, acumulador, opcion). El gating no
      //depende del server — usa lastClaimAtPorAldea local + aldea.loot del
      //bootstrap. Las saltadas registran su `status:"saltada-cooldown"` en
      //historial y suman al acumulador acá, sin pegarle al server.
      //
      //La info por ciudad (saltadas + tiempo a próxima libre) se guarda en
      //ciudadInfo y se loguea en Pass 2 cuando se emite el banner de la
      //ciudad — así el log queda visualmente agrupado por ciudad.
      const tareas = [];
      const ciudadInfo = new Map();

      for (let idxCiudad = 0; idxCiudad < ciudadesOrdenadas.length; idxCiudad++) {
        const ciudad = ciudadesOrdenadas[idxCiudad];
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        //Margen de +5s sobre el cooldown server real (5 o 10min). Cubre
        //drift de reloj cliente/server, latencia de red y jitter del
        //setTimeout. Costo: ~1.7% de yield en ciudades de 5min, ~0.8% en
        //10min — despreciable.
        const cooldownMs = cfg.minutos * 60 * 1000 + 5 * 1000;
        const acumulador = acumuladoCiclo[ciudad.codigoCiudad];

        let saltadasPorCooldown = 0;
        let restanteMinSeg = Infinity;

        //Orden DETERMINISTA (alfabético por nombre de aldea) — NO shuffle.
        //
        //Por qué este cambio importa para la fórmula de esperaNormal:
        //
        //La fórmula `baseMs - duracionCiclo + 30s` asume que cada aldea está
        //en la MISMA posición temporal del ciclo en ambas vueltas (N y N+1).
        //Con eso, su CD entre claims es ≈ `baseMs + 30s ± varianza_jitter`
        //(σ ≈ 0.2·√pos segundos — chica).
        //
        //Si en cambio shuffleamos las aldeas dentro de la ciudad, una aldea
        //que estaba al FINAL del ciclo N (offset ≈ duracionCiclo) puede caer
        //al INICIO del ciclo N+1 (offset ≈ 0). Su CD efectivo se reduce en
        //`duracionCiclo` entera — para 100 ciudades eso es 150-600s. La
        //gracia de 30s NO cubre eso. Resultado: server rechaza esa aldea.
        //
        //Trade-off: orden 100% predecible aldea-por-aldea. La huella anti-bot
        //la siguen dando (a) el jitter random [0, 500ms] entre claims, (b)
        //el orden alfabético-natural de ciudades (también determinista pero
        //no obviamente "secuencial" como sería claim-id-1, claim-id-2…).
        //
        //Si en algún momento el server activa anti-bot por orden de aldeas
        //dentro de una ciudad, tocará pensar en una solución que no rompa
        //la fórmula (probablemente: shuffle pero MISMO shuffle entre ciclos —
        //e.g. seed determinista por (ciudadId, dayOfYear)).
        const aldeasOrdenadas = ciudad.aldeas.slice().sort((x, y) => {
          const nx = x.name || `farm_${x.id}`;
          const ny = y.name || `farm_${y.id}`;
          return nx.localeCompare(ny, undefined, { numeric: true });
        });
        for (const aldea of aldeasOrdenadas) {
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
              acumulador.saltadasCooldown += 1;
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
            saltadasPorCooldown += 1;
            acumulador.saltadasCooldown += 1;
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

          //Aldea pasa el gate → entra a la cola de fires del Pass 2.
          tareas.push({ ciudad, aldea, acumulador, opcion: cfg.opcion, idxCiudad });
        }

        ciudadInfo.set(ciudad.codigoCiudad, {
          nombre: ciudad.nombreCiudad || ciudad.codigoCiudad,
          minutos: cfg.minutos,
          saltadas: saltadasPorCooldown,
          restanteSeg: restanteMinSeg,
          totalAldeas: ciudad.aldeas.length,
        });

        //Propagar al global el mínimo entre ciudades — recolectarRecursos lo
        //usa para adelantar el próximo tick si la próxima aldea se libera
        //antes del intervalo normal.
        if (restanteMinSeg < cicloState.proximaLiberacionSeg) {
          cicloState.proximaLiberacionSeg = restanteMinSeg;
        }
      }

      //═══ Pass 2: fire-and-forget de los claims ═══
      //
      //Cada iteración dispara un claim sin awaitarlo (excepto el último).
      //La response llega asincrónica, dispara `manejarResultadoClaim` que
      //actualiza estado (lastClaimAt, ciclo stats) y, si hubo error
      //recuperable, encola en `pendientes` para retry diferido.
      //
      //Entre fires hay jitter [0, 500ms] — el único bloqueo del loop.
      //Con response time típico de 200-500ms, la primera response llega
      //antes del 2°-3° fire siguiente, así que las decisiones de "saltar
      //resto de aldeas porque ciudad se llenó" se aplican con ≤2 claims de
      //waste por ciudad llena.
      //
      //Captcha: se chequea al inicio de cada iteración. Si una response
      //previa ya disparó onCaptchaDetectado() (sin Town notification),
      //isCaptchaActive() devuelve true y cortamos el firing. Las responses
      //ya en flight terminan llegando — bounded waste de ~2-5 claims según
      //timing.
      //
      //Última tarea AWAITADA: las anteriores son fire-and-forget para no
      //bloquear el loop por la latencia del server (200-500ms × N aldeas
      //sería el cuello de botella). La última se awaitea para que cuando
      //recolectarCiudades retorne, el `duracionCiclo = now() - inicioCiclo`
      //refleje también la última response — sin esto, el ciclo "termina"
      //~response_time antes de que el server la registre y el
      //esperaNormal podría arrancar el siguiente ciclo apenas demasiado
      //pronto.
      const promesasFire = [];
      const ciudadesConBanner = new Set();
      let abortedByCaptcha = false;
      let idxCiudadActual = 0;

      const manejarResultadoClaim = (t, r) => {
        if (r && r.status === "ok") {
          lastClaimAtPorAldea[t.aldea.id] = Date.now();
          guardarLastClaimAt();
        } else if (r && r.status === "reintentar") {
          //Server rechazó (success:false) — encolamos para retry diferido al
          //final del ciclo. Conservamos acumulador+opcion para que la tanda
          //quede correctamente contabilizada cuando el retry funcione.
          pendientes.push({
            ciudad: t.ciudad, aldea: t.aldea,
            acumulador: t.acumulador, opcion: t.opcion,
            intentos: 1,
          });
        }
        //status === "descartar": no-op (recolectarAldea ya lo gestionó —
        //recursosLlenos / sin relation / cooldown server / no-pertenece /
        //CAPTCHA).
      };

      const manejarErrorClaim = (t, e) => {
        core.logError(
          "recoleccion",
          `falló aldea id=${t.aldea && t.aldea.id} (${t.ciudad.nombreCiudad || t.ciudad.codigoCiudad})`,
          e
        );
        //Network error / abort / parse error — vale retry, es transitorio.
        //AbortError del timeout de 30s también cae acá.
        pendientes.push({
          ciudad: t.ciudad, aldea: t.aldea,
          acumulador: t.acumulador, opcion: t.opcion,
          intentos: 1,
        });
      };

      for (let i = 0; i < tareas.length; i++) {
        const t = tareas[i];
        idxCiudadActual = t.idxCiudad;

        if (core.isCaptchaActive()) {
          abortedByCaptcha = true;
          core.logWarn("recoleccion", "CAPTCHA activo — bot detenido, esperando al humano");
          break;
        }
        if (core.isPaused()) break;

        //Si una response previa marcó la ciudad como llena, saltamos las
        //aldeas restantes de ESA ciudad. Sigue procesando otras ciudades —
        //no abortamos el ciclo entero. La ciudad llena se va a desbloquear
        //sola cuando el jugador construya / haga upgrades.
        if (t.ciudad.recursosLlenos) continue;

        //Banner per ciudad — emitido cuando llega su primera tarea. Una
        //ciudad 6/6 cooldowned (sin tareas en Pass 2) no llega acá y por
        //tanto no tiene banner; en su lugar Pass 1 ya registró las saltadas.
        if (!ciudadesConBanner.has(t.ciudad.codigoCiudad)) {
          core.logCiclo(
            "recoleccion",
            t.ciudad.nombreCiudad || t.ciudad.codigoCiudad,
            "info"
          );
          ciudadesConBanner.add(t.ciudad.codigoCiudad);
          //Log de saltadas por cooldown justo después del banner — visualmente
          //agrupado con la ciudad que pertenece.
          const info = ciudadInfo.get(t.ciudad.codigoCiudad);
          if (info && info.saltadas > 0) {
            core.log(
              "recoleccion",
              `${info.nombre}: ${info.saltadas}/${info.totalAldeas} aldeas en cooldown (${info.minutos}min) — próxima en ${core.formatDuracion(info.restanteSeg)}`
            );
          }
        }

        const isLast = (i === tareas.length - 1);

        if (isLast) {
          //Última tarea: AWAIT para timing preciso de duracionCiclo. Ver
          //comentario superior sobre por qué se trata distinto del resto.
          try {
            const r = await recolectarAldea(t.ciudad, t.aldea, t.acumulador, t.opcion);
            manejarResultadoClaim(t, r);
          } catch (e) {
            manejarErrorClaim(t, e);
          }
        } else {
          //Fire-and-forget: el fetch dispara, pero el loop sigue al jitter.
          //La IIFE async envuelve try/catch para que cualquier error en el
          //handler caiga en manejarErrorClaim sin tirar un unhandled rejection.
          const promesa = (async () => {
            try {
              const r = await recolectarAldea(t.ciudad, t.aldea, t.acumulador, t.opcion);
              manejarResultadoClaim(t, r);
            } catch (e) {
              manejarErrorClaim(t, e);
            }
          })();
          promesasFire.push(promesa);

          //Jitter entre fires — el único bloqueo del loop. Con [0, 500ms] y
          //600 aldeas el ciclo dispara todos en ~150s.
          await delayMs(jitter(0, 500));
        }
      }

      //Esperar que todas las responses en flight lleguen ANTES del retry
      //phase. Sin esto, `pendientes` podría estar incompleto (responses
      //tardías que aún no llegaron) y el retry empezaría con info parcial.
      //También garantiza que cuando recolectarCiudades retorne, todas las
      //actualizaciones de lastClaimAt / cicloActual / recursosLlenos ya
      //fueron procesadas.
      await Promise.allSettled(promesasFire);

      //Si se abortó por CAPTCHA, mergear al contexto del core las ciudades
      //que NO llegamos a procesar + las aldeas no claimeadas de la ciudad
      //parcial actual. La sincronización post-resolver va a refrescar TODAS
      //las ciudades del jugador igual, así que esto es sobre todo para que
      //el cartel muestre cuántas aldeas quedaron en cola.
      if (abortedByCaptcha) {
        const pend = [];
        const ahora = Date.now();
        for (let i = idxCiudadActual; i < ciudadesOrdenadas.length; i++) {
          const c = ciudadesOrdenadas[i];
          const cfg = getConfigCiudad(c.codigoCiudad);
          const cooldownMs = cfg.minutos * 60 * 1000;
          //Filtrar las aldeas ya claimeadas en este ciclo (lastClaimAt
          //reciente). En la ciudad parcial actual hay aldeas que ya se
          //procesaron antes de la que disparó el captcha — no queremos
          //que aparezcan como "pendientes" en el cartel.
          const aldeasNoClaimeadas = (c.aldeas || []).filter((a) => {
            const last = lastClaimAtPorAldea[a.id] || 0;
            return last === 0 || (ahora - last) >= cooldownMs;
          }).map((a) => ({
            id: a.id,
            nombre: a.name || `farm_${a.id}`,
          }));
          if (aldeasNoClaimeadas.length) {
            pend.push({
              ciudadId: c.codigoCiudad,
              ciudadNombre: c.nombreCiudad || c.codigoCiudad,
              aldeas: aldeasNoClaimeadas,
            });
          }
        }
        //Llamar al core con ctx solo para mergear `pendientes` — captcha ya
        //está activo, así que el flujo "ya estábamos en pending" hace merge
        //sin reiniciar timeout.
        core.onCaptchaDetectado({ feature: "recoleccion", ciclo: nCiclo, pendientes: pend });
      }

      //Retry diferido — máx 3 intentos por aldea (1 inicial + 2 reintentos),
      //con espera de 5s entre rondas. Esa pausa le da aire al server (la
      //mayoría de success:false son por cooldown casi vencido o rate limit
      //transitorio) y reduce la chance de pegarle de nuevo justo cuando
      //todavía no liberó.
      //
      //El retry SÍ es síncrono (await por aldea). Es un volumen chico (≤3-5
      //aldeas en el peor caso) y conviene tener el resultado confirmado
      //antes de cerrar el ciclo.
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
            if (item.acumulador) item.acumulador.reintentadasFallidas += 1;
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
          //Jitter chico entre retries — mismo orden de magnitud que el ciclo
          //principal, pero secuencial (await) porque el volumen es bajo.
          await delayMs(jitter(0, 500));
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
        if (!acc) continue;
        //Skip ciudades sin actividad (no debería pasar — todas tienen 6
        //aldeas — pero es defensivo).
        const total = acc.claims + acc.saltadasCooldown + acc.descartadasOtras + acc.reintentadasFallidas + acc.bloqueadas;
        if (total === 0) continue;

        const nombre = ciudad.nombreCiudad || ciudad.codigoCiudad;
        const recursos = `${fmt(acc.wood)}/${fmt(acc.stone)}/${fmt(acc.iron)}`;

        //Desglose: claims OK + saltadas por cooldown legítimo (cliente o
        //server) + bloqueadas (sin acceso) cuentan como "esperado". Solo
        //es tanda incompleta REAL si hubo descartes (recursosLlenos / sin
        //relation / sin Town / CAPTCHA) o reintentos agotados — esos sí
        //son yield perdido.
        const partes = [`${acc.claims} ok`];
        if (acc.saltadasCooldown) partes.push(`${acc.saltadasCooldown} en cooldown`);
        if (acc.bloqueadas) partes.push(`${acc.bloqueadas} sin acceso`);
        if (acc.reintentadasFallidas) partes.push(`${acc.reintentadasFallidas} fallaron tras retry`);
        if (acc.descartadasOtras) partes.push(`${acc.descartadasOtras} descartadas`);
        const desglose = partes.join(", ");

        //Las bloqueadas (no le pertenecen al jugador) no son aldeas
        //farmeables: las descontamos del total esperado para que una
        //ciudad recién fundada con 4/6 aldeas conquistadas no marque la
        //tanda como incompleta cada ciclo.
        const esperadoCiudad = TOTAL_ESPERADO - acc.bloqueadas;
        const esperado = acc.claims + acc.saltadasCooldown;
        const fallasReales = acc.reintentadasFallidas + acc.descartadasOtras;

        if (fallasReales === 0 && esperado === esperadoCiudad) {
          //Tanda OK: todo lo que faltó claimear estaba en cooldown legítimo
          //o sin acceso (esperado para esta ciudad).
          core.log("recoleccion", `─── ${nombre}: ${desglose} → ${recursos} ───`, "ok");
        } else if (fallasReales === 0) {
          //Sin fallas reales pero la suma no llega al esperado — caso raro
          //(e.g. la cantidad de aldeas que el server devolvió no coincide
          //con esperadoCiudad). Logueamos como warn, no como error.
          core.logWarn(
            "recoleccion",
            `${nombre}: ${desglose} → ${recursos} (esperado ${esperadoCiudad}, contadas ${esperado})`
          );
        } else {
          //Hubo fallas reales — yield perdido, log rojo.
          core.logError(
            "recoleccion",
            `tanda incompleta — ${nombre}: ${desglose} → ${recursos}`
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

    /**
     * Reclama una aldea. Retorna un objeto `{ status }` con uno de:
     *   - 'ok'         claim exitoso (server confirmó con notification 'Town')
     *   - 'reintentar' fallo recuperable (success:false del server) — vale la
     *                  pena reintentar al final del ciclo
     *   - 'descartar'  fallo no recuperable en este ciclo (sin relation_id,
     *                  almacén lleno, CAPTCHA, sin Town) — no reintentar
     * El caller (manejarResultadoClaim en recolectarCiudades) usa el status
     * para decidir si actualiza lastClaimAtPorAldea y/o si encola la aldea
     * para retry.
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
        if (acumulador) acumulador.descartadasOtras += 1;
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
        if (acumulador) acumulador.descartadasOtras += 1;
        return { status: "descartar" };
      }

      //El jitter entre claims se aplica AHORA EN EL CALLER (recolectarCiudades)
      //porque el ciclo dispara los claims en modo fire-and-forget: cada claim
      //fire-y-sigue, las respuestas llegan asíncronas y actualizan estado en
      //background. El caller espera `jitter(0, 500)` entre fires consecutivos.
      //Con jitter chico (<500ms) y N grande (>40 ciudades), la varianza
      //acumulada entre ciclos es del orden de √N · 200ms ≈ pocos segundos —
      //la gracia de 30s en esperaNormal la cubre con margen >5σ.

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
      //resuelve (TCP sin respuesta, server colgado) deja el promise pendiente
      //para siempre — `Promise.allSettled` nunca termina y el ciclo no cierra.
      //Con el abort, el .catch del fire-and-forget en recolectarCiudades
      //captura AbortError y la aldea entra a `pendientes` para retry diferido.
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
        //Extraer mensaje de error de los varios campos posibles donde el
        //server lo puede poner (Grepolis no es consistente).
        const r = response.json || {};
        const errorMsg =
          (r.errors && r.errors[0]) ||
          r.error_msg ||
          r.error ||
          (r.response && r.response.error) ||
          "success=false";

        //Detectar específicamente "Tu petición no está lista aún." (o el
        //equivalente en otros idiomas) — eso significa que el server
        //tiene cooldown vivo. Causas típicas:
        //  - claim manual del usuario que el bot no registró
        //  - cooldown server más largo del configurado (ciudad con
        //    Lealtad de los aldeanos pero config en 5min)
        //  - drift de reloj cliente/server
        //En cualquier caso lo correcto es ASUMIR que la aldea acaba de
        //ser claimeada (lastClaimAtPorAldea = ahora) y NO entrar al
        //retry loop. Antes el bot mandaba 3× requests inútiles en 30s.
        const esCooldownServer = typeof errorMsg === "string" &&
          /no est[áa] lista|not ready|cooldown|already claim/i.test(errorMsg);

        if (esCooldownServer) {
          core.logWarn(
            "recoleccion",
            `aldea ${farmTownId} (${ciudadNombreSafe}): server reporta cooldown vivo ("${errorMsg}") — aprendiendo, no reintentar este ciclo`
          );
          //Tratar como recién claimeada — el próximo ciclo respeta el
          //cooldownMs completo desde ahora sin volver a pegarle al server.
          lastClaimAtPorAldea[farmTownId] = Date.now();
          guardarLastClaimAt();
          registrarClaim({
            aldeaId: farmTownId, ciudadId: codigoCiudad,
            ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
            ciclo: nCiclo, status: "descartar",
            errorMsg: `cooldown server: ${errorMsg}`,
          });
          //Conceptualmente es lo mismo que cooldown cliente: el server nos
          //dice "todavía no toca". No es error, es expected — cuenta como
          //saltada-cooldown para que el resumen no pinte la tanda en rojo.
          if (acumulador) acumulador.saltadasCooldown += 1;
          return { status: "descartar" };
        }

        //Detectar específicamente "Esta aldea no te pertenece" (server
        //rechaza porque la aldea todavía no fue conquistada por el
        //jugador). Es expected — cada ciudad tiene 6 aldeas potenciales
        //pero las recién fundadas las desbloquean de a poco. Descarte
        //silencioso: log info (no warn), nuevo status "no-pertenece" en
        //el historial → la UI muestra "Sin acceso" en gris en vez de
        //"Pendiente" naranja, y el resumen de tanda no la cuenta como
        //fallo.
        const esAldeaNoPropia = typeof errorMsg === "string" &&
          /no te pertenece|does not belong|doesn't belong|not yours|nicht.*geh[öo]rt/i.test(errorMsg);

        if (esAldeaNoPropia) {
          core.log(
            "recoleccion",
            `aldea ${farmTownId} (${ciudadNombreSafe}): sin acceso — ${errorMsg}`
          );
          registrarClaim({
            aldeaId: farmTownId, ciudadId: codigoCiudad,
            ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
            ciclo: nCiclo, status: "no-pertenece",
            errorMsg,
          });
          if (acumulador) acumulador.bloqueadas += 1;
          //Ajustar el esperado del ciclo en vivo: la card de la ciudad
          //muestra "claims/esperado" (default 6) y el header global muestra
          //"X/totalAldeas". Sin este ajuste, una ciudad con 4 aldeas
          //farmeables y 2 sin acceso quedaría visualmente como 4/6 rojo
          //hasta el final del ciclo, aunque conceptualmente esté completa.
          //También recheck `ciudadesCompletadas` por si la última bloqueada
          //llega DESPUÉS del último claim OK (en ese caso el incremento
          //"normal" en c.claims >= c.esperado nunca dispara, porque acá
          //no aumentamos claims sino que bajamos esperado).
          if (cicloActual && cicloActual.ciudades[codigoCiudad]) {
            const cc = cicloActual.ciudades[codigoCiudad];
            const eraCompleta = cc.claims >= cc.esperado;
            cc.esperado = Math.max(0, (cc.esperado || 6) - 1);
            cicloActual.totalAldeas = Math.max(0, cicloActual.totalAldeas - 1);
            if (!eraCompleta && cc.claims >= cc.esperado) {
              cicloActual.ciudadesCompletadas += 1;
            }
            actualizarIndicadorVivo();
          }
          return { status: "descartar" };
        }

        //Otros errores (rate limit transitorio, etc): retry diferido como
        //antes — vale la pena darle otra chance. El errorMsg va en el texto
        //principal para que se lea bien en chrome://extensions (donde el
        //extra aparece como [object Object]).
        const errorMsgCorto = typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg);
        core.logWarn(
          "recoleccion",
          `aldea ${farmTownId} (${ciudadNombreSafe}): server rechazó claim — "${errorMsgCorto}" (se reintenta al final del ciclo)`,
          {
            errors: r.errors,
            error_msg: r.error_msg,
            notifications: r.notifications,
            response: r,
          }
        );
        registrarClaim({
          aldeaId: farmTownId, ciudadId: codigoCiudad,
          ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
          ciclo: nCiclo, status: "reintentar",
          errorMsg,
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
        //Pasamos contexto al core: quién falló + ciclo. Las pendientes
        //(aldeas no procesadas del ciclo) se mergean en recolectarCiudades
        //cuando ve que rompimos el loop por captcha (después del
        //Promise.allSettled, así todas las responses en flight ya cerraron).
        core.onCaptchaDetectado({
          feature: "recoleccion",
          ciclo: nCiclo,
          ciudad: { id: codigoCiudad, nombre: ciudadNombreSafe },
          aldea: { id: farmTownId, nombre: aldeaNombreSafe },
        });
        registrarClaim({
          aldeaId: farmTownId, ciudadId: codigoCiudad,
          ciudadNombre: ciudadNombreSafe, aldeaNombre: aldeaNombreSafe,
          ciclo: nCiclo, status: "descartar",
          errorMsg: "sin Town notification (probable CAPTCHA)",
        });
        if (acumulador) acumulador.descartadasOtras += 1;
        //CAPTCHA → descartar (no reintentar este ciclo). El bot queda
        //esperando al humano (cartel + botón "Ya resolví" en la UI).
        return { status: "descartar" };
      }

      //NO disparamos onCaptchaResuelto desde acá. El usuario tiene control
      //explícito vía el botón "Ya resolví" en la UI: ahí se hace la
      //sincronización del estado del server. Reanudar solo porque un fetch
      //salió OK sería ruido (y quitaría al usuario el control que pidió).

      //Refresca el ícono "disponible" sobre la aldea en el mapa de isla.
      //El response no trae notification de FarmTownPlayerRelation, así que
      //sin esto el ícono verde se queda visible hasta el próximo cambio de
      //ciudad. El bridge reinicia lootable_at/last_looted_at del modelo y
      //Backbone re-renderea la vista.
      window.dispatchEvent(
        new CustomEvent("JamBot:markFarmTownClaimed", {
          detail: { relationId },
        })
      );

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
        cicloActual.ultimoClaimAt = Date.now();
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

    /**
     * Pide la colección FarmTownPlayerRelations al server. Devuelve:
     *   - relacionPorAldea: { farm_town_id → relation_id } (lo usa el claim).
     *   - cooldownSegPorAldea: { farm_town_id → seg } con el cooldown real
     *     que el server tiene activo para esa aldea, derivado de
     *     `lootable_at - last_looted_at` (mismo patrón que el bridge —
     *     ver gameBridge.js:80). Solo presente para aldeas con al menos
     *     un claim histórico (ambos campos > 0). Lo usa la auto-detección
     *     del cooldown por ciudad — la habilidad "Lealtad de los aldeanos"
     *     se estudia por ciudad y duplica el cooldown (5min → 10min), así
     *     que cualquier aldea con datos basta para inferirlo.
     */
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

      const relacionPorAldea = {};
      const cooldownSegPorAldea = {};
      for (const item of items) {
        const rel = item.d || item;
        if (!rel || rel.farm_town_id == null || rel.id == null) continue;
        relacionPorAldea[rel.farm_town_id] = rel.id;
        const cooldown = (rel.lootable_at || 0) - (rel.last_looted_at || 0);
        if (cooldown > 0) cooldownSegPorAldea[rel.farm_town_id] = cooldown;
      }
      return { relacionPorAldea, cooldownSegPorAldea };
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
        //ciclo (Pass 1 de recolectarCiudades mira `aldea.loot` cuando no hay
        //entrada en lastClaimAtPorAldea para esa aldea).
        if (Array.isArray(aldeasCiudad)) {
          for (const a of aldeasCiudad) {
            if (a && a.loot && a.loot > ahoraSec) aldeasEnCooldownAlBoot += 1;
          }
        }

        ciudadesConAldeas.push({
          codigoCiudad: ciudad.id,
          nombreCiudad: ciudad.name,
          //islandId: lo necesitamos para refrescar las aldeas vía
          //island_info en la sincronización post-CAPTCHA (sin esto,
          //tendríamos que rehacer obtenerCiudadesConAldeas completo).
          islandId: ciudad.island_id,
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
