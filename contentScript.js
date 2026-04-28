//TODO: Hacer que actualice la interfaz
(async () => {
  console.log("Welcome JamBot");
  //Importar save token
  injectScript(chrome.runtime.getURL("/js/saveToken.js"), "body");
  //Bridge para refrescar la UI tras claims (dispatch de notifications a Backbone)
  injectScript(chrome.runtime.getURL("/js/gameBridge.js"), "body");

  //Importar json data
  let data = await fetch(chrome.runtime.getURL("/data.json"));
  data = await data.json();

  //Variables
  let ciudadesConAldeas = [];

  const game = JSON.parse(window.localStorage.getItem("game"));
  const { csrfToken, world_id, townId, player_id } = game;

  console.log({ world_id, csrfToken, townId, player_id });
  console.log("Obteniendo informacion...");
  await obtenerCiudadesConAldeas();
  data.relacionPorAldea = await obtenerMapaRelaciones();

  console.log({ ciudadesConAldeas, relacionPorAldea: data.relacionPorAldea });
  console.log("Carga exitosa");

  //Estado del bot — afectado por el CAPTCHA
  let captchaActive = false;

  //Snapshot de recursos por ciudad para calcular cuánto se ganó en cada claim
  const recursosPrevPorCiudad = {};

  /**
   * Pregunta al bridge los recursos actuales del Town cargado en MM. Devuelve
   * { wood, stone, iron } o null si el Town no está cargado o no respondió.
   */
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

  //Escuchar señales del bridge (vigilancia de Game.bot_check)
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.type !== "JamBot:captchaState") return;
    if (msg.active) onCaptchaDetectado();
    else onCaptchaResuelto();
  });

  insertarBotonDeRecolectarRecursos();

  function insertarBotonDeRecolectarRecursos() {
    const botonRecolectarRecursos = document.createElement("button");
    botonRecolectarRecursos.innerHTML = "-Jam-";
    botonRecolectarRecursos.id = "botonRecolectarRecursos";
    botonRecolectarRecursos.style.cssText +=
      "position:absolute;bottom:80px;left:10px;z-index:1000;padding:6px 10px;font-weight:bold";
    document.body.appendChild(botonRecolectarRecursos);
    botonRecolectarRecursos.addEventListener("click", recolectarRecursos);
  }

  function pintarEstadoBoton(estado, msEspera) {
    const boton = document.getElementById("botonRecolectarRecursos");
    if (!boton) return;
    switch (estado) {
      case "recolectando":
        boton.innerHTML = "...";
        boton.style.background = "#f5d36b";
        boton.style.color = "#000";
        break;
      case "esperando": {
        const min = msEspera ? Math.round(msEspera / 60000) : null;
        boton.innerHTML = min ? `-Jam- (${min}m)` : "-Jam-";
        boton.style.background = "";
        boton.style.color = "";
        break;
      }
      case "captcha":
        boton.innerHTML = "⚠ CAPTCHA";
        boton.style.background = "#c0392b";
        boton.style.color = "#fff";
        break;
      default:
        boton.innerHTML = "-Jam-";
        boton.style.background = "";
        boton.style.color = "";
    }
  }

  let tituloOriginal = null;
  let tituloFlashId = null;

  function onCaptchaDetectado() {
    if (captchaActive) return; //ya estaba activo, ignorar duplicados
    captchaActive = true;
    console.warn("[JamBot] CAPTCHA detectado — pausando bot");
    pintarEstadoBoton("captcha");
    iniciarFlashTitulo();
    sonarAlerta();
    chrome.runtime.sendMessage({ type: "JamBot:badge", text: "!", color: "#c0392b" });
  }

  function onCaptchaResuelto() {
    if (!captchaActive) return;
    captchaActive = false;
    console.log("[JamBot] CAPTCHA resuelto — reanudando bot");
    pararFlashTitulo();
    pintarEstadoBoton("esperando");
    chrome.runtime.sendMessage({ type: "JamBot:badge", text: "" });
  }

  function iniciarFlashTitulo() {
    if (tituloFlashId) return;
    if (tituloOriginal == null) tituloOriginal = document.title;
    let mostrandoAlerta = false;
    tituloFlashId = setInterval(() => {
      mostrandoAlerta = !mostrandoAlerta;
      document.title = mostrandoAlerta ? "⚠ CAPTCHA — JamBot" : tituloOriginal;
    }, 1000);
  }

  function pararFlashTitulo() {
    if (!tituloFlashId) return;
    clearInterval(tituloFlashId);
    tituloFlashId = null;
    if (tituloOriginal != null) document.title = tituloOriginal;
  }

  function sonarAlerta() {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.1;
      o.start();
      setTimeout(() => {
        o.stop();
        ctx.close();
      }, 400);
    } catch (e) {
      //sonido es nice-to-have, no bloqueamos por esto
    }
  }

  let proximoTickId = null;

  async function recolectarRecursos() {
    const { tiempoRecoleccion } = data;
    pintarEstadoBoton(captchaActive ? "captcha" : "recolectando");

    await recolectarCiudades();

    //Si el ciclo terminó con captcha activo, probamos en 30s para detectar
    //la resolución rápido en cuanto el jugador resuelva el modal. Si no,
    //ciclo normal: tiempoRecoleccion + 20s de margen.
    const tiempoEspera = captchaActive
      ? 30 * 1000
      : tiempoRecoleccion * 60 * 1000 + 20 * 1000;

    console.log(
      `Tiempo de espera hasta proxima recoleccion ${tiempoEspera} en milisegundos${captchaActive ? " (modo CAPTCHA)" : ""}`
    );

    pintarEstadoBoton(captchaActive ? "captcha" : "esperando", tiempoEspera);
    programarSiguienteTick(tiempoEspera);
  }

  function programarSiguienteTick(ms) {
    if (proximoTickId) clearTimeout(proximoTickId);
    proximoTickId = setTimeout(async () => {
      proximoTickId = null;
      await recolectarRecursos();
    }, ms);
  }

  async function recolectarCiudades() {
    const { ciudadesConAldeas } = data;

    let horaActual = new Date();
    console.log(
      `Recolectando aldeas - Time: ${horaActual.getHours()}:${horaActual.getMinutes()}:${horaActual.getSeconds()}`
    );

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

    //Acumulador por ciudad para el resumen al final del ciclo.
    const acumuladoCiclo = {};

    //Importante: NO hacer early-skip aquí aunque captchaActive sea true.
    //Necesitamos hacer al menos un claim de "probe" para detectar si el
    //CAPTCHA ya se resolvió. La detección post-claim cortará el ciclo si
    //sigue activo.
    for (const ciudad of ciudadesConAldeas) {
      acumuladoCiclo[ciudad.codigoCiudad] = { wood: 0, stone: 0, iron: 0, claims: 0 };
      await recolectarCiudad(ciudad, acumuladoCiclo[ciudad.codigoCiudad]);
      if (captchaActive) {
        console.warn("[JamBot] CAPTCHA activo — abortando ciclo");
        break;
      }
    }

    //Resumen por ciudad (solo las que tuvieron al menos un claim contado)
    for (const ciudad of ciudadesConAldeas) {
      const acc = acumuladoCiclo[ciudad.codigoCiudad];
      if (!acc || acc.claims === 0) continue;
      const nombre = ciudad.nombreCiudad || ciudad.codigoCiudad;
      console.log(
        `[JamBot] === ${nombre} (tanda): ${acc.claims} aldeas → +${acc.wood} madera, +${acc.stone} piedra, +${acc.iron} plata ===`
      );
    }
  }

  const recolectarCiudad = async (ciudad, acumulador) => {
    const { aldeas } = ciudad;

    for (const aldea of aldeas) {
      try {
        await recolectarAldea(ciudad, aldea, acumulador);
      } catch (e) {
        console.error("Falló aldea", aldea && aldea.id, e);
      }
      if (captchaActive) break; //tras el primer claim que detecte captcha, paramos
    }
  };

  const recolectarAldea = async (ciudad, aldea, acumulador) => {
    const { recursosLlenos, codigoCiudad } = ciudad;
    const { opcionRecoleccion } = data;

    if (recursosLlenos) {
      return;
    }

    const farmTownId = aldea.id;
    const relationId = data.relacionPorAldea && data.relacionPorAldea[farmTownId];
    if (relationId == null) {
      console.warn("Sin relation_id para farm_town_id", farmTownId, "— saltada");
      return;
    }

    //Espera entre recoleccion, para evitar ban
    await delaySeconds(1);

    const json = {
      model_url: `FarmTownPlayerRelation/${relationId}`,
      action_name: "claim",
      captcha: null,
      arguments: {
        farm_town_id: farmTownId,
        type: "resources",
        option: opcionRecoleccion,
      },
      town_id: codigoCiudad,
      nl_init: true,
    };

    const datos = new URLSearchParams();

    datos.append("json", JSON.stringify(json));

    let response = await fetch(
      `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${codigoCiudad}&action=execute&h=${csrfToken}`,
      {
        method: "POST",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          accept: "text/plain, */*; q=0.01",
        },

        body: datos,
      }
    );

    response = await response.json();

    if (!response.json["success"]) {
      return;
    }

    //Despachar notifications al bridge para que actualice los modelos
    //Backbone (Town, FarmTownPlayerRelation) y la UI se refresque sola.
    window.dispatchEvent(
      new CustomEvent("JamBot:dispatchNotifications", {
        detail: { notifications: response.json.notifications },
      })
    );

    //Parseo response (para detectar almacén lleno y cachear el flag)
    const townNotification = response.json.notifications.find(
      (element) => element.subject == "Town"
    );

    if (!townNotification) {
      console.warn(
        "[JamBot] Sin notificación 'Town' para aldea", farmTownId,
        "— probable CAPTCHA activo. Notifications:", response.json.notifications
      );
      onCaptchaDetectado();
      return;
    }

    //Town presente → claim aplicado → si veníamos marcados como CAPTCHA, ya
    //está resuelto.
    if (captchaActive) onCaptchaResuelto();

    const town = JSON.parse(townNotification.param_str)["Town"];
    const { storage, last_wood, last_iron, last_stone, resources } = town;

    //Log: cuánto se ganó (diff con snapshot anterior) y total resultante
    const nombreCiudad = ciudad.nombreCiudad || codigoCiudad;
    const nombreAldea = aldea.name || `farm_${farmTownId}`;
    const prev = recursosPrevPorCiudad[codigoCiudad];
    if (prev && resources) {
      const dW = resources.wood - prev.wood;
      const dS = resources.stone - prev.stone;
      const dI = resources.iron - prev.iron;
      console.log(
        `[JamBot] ${nombreCiudad} ← ${nombreAldea} (id ${farmTownId}): +${dW} madera, +${dS} piedra, +${dI} plata · total ${resources.wood}/${resources.stone}/${resources.iron}`
      );
      if (acumulador) {
        acumulador.wood += dW;
        acumulador.stone += dS;
        acumulador.iron += dI;
        acumulador.claims += 1;
      }
    } else if (resources) {
      console.log(
        `[JamBot] ${nombreCiudad} ← ${nombreAldea} (id ${farmTownId}): recolectada · total ${resources.wood}/${resources.stone}/${resources.iron}`
      );
      if (acumulador) acumulador.claims += 1;
    }
    if (resources) recursosPrevPorCiudad[codigoCiudad] = { ...resources };

    const indexCiudadActual = data.ciudadesConAldeas.findIndex(
      (ciudadData) => ciudadData.codigoCiudad == codigoCiudad
    );

    data.ciudadesConAldeas[indexCiudadActual].recursosLlenos =
      storage == last_wood && storage == last_iron && storage == last_stone;
  };

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
    //Obtiene lista de ciudades con su isla
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

    //Obtener aldeas por ciudad
    for (const ciudadJugador of ciudadesJugador) {
      const ciudad = ciudadJugador.d;
      await delaySeconds(0.2);
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

      ciudadesConAldeas.push({
        codigoCiudad: ciudad.id,
        nombreCiudad: ciudad.name,
        aldeas: aldeasCiudad,
      });

      data.ciudadesConAldeas = ciudadesConAldeas;
    }
  }
})();

//Cool functions
function injectScript(file, node) {
  var th = document.getElementsByTagName(node)[0];
  var s = document.createElement("script");
  s.setAttribute("type", "text/javascript");
  s.setAttribute("src", file);
  th.appendChild(s);
}

function delaySeconds(seconds) {
  return new Promise(function (resolve) {
    setTimeout(resolve, seconds * 1000);
  });
}
