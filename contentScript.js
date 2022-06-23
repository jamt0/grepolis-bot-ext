//TODO: Hacer que actualice la interfaz
(async () => {
  console.log("Welcome JamBot");
  //Importar save token
  injectScript(chrome.runtime.getURL("/js/saveToken.js"), "body");

  //Importar json data
  let data = await fetch(chrome.runtime.getURL("/data.json"));
  data = await data.json();

  //Variables
  let ciudadesConAldeas = [];

  const game = JSON.parse(window.localStorage.getItem("game"));
  console.log({ game });
  const { csrfToken, world_id, townId } = game;

  console.log({ world_id, csrfToken, townId });
  console.log("Obteniendo informacion...");
  await obtenerCiudadesConAldeas();

  console.log({ ciudadesConAldeas });
  console.log("Carga exitosa");

  insertarBotonDeRecolectarRecursos();

  function insertarBotonDeRecolectarRecursos() {
    const botonRecolectarRecursos = document.createElement("button");
    botonRecolectarRecursos.innerHTML = "-Jam-";
    botonRecolectarRecursos.id = "botonRecolectarRecursos";
    botonRecolectarRecursos.style.cssText +=
      "position:absolute;bottom:80px;left:10px;z-index:1000";
    document.body.appendChild(botonRecolectarRecursos);
    botonRecolectarRecursos.addEventListener("click", recolectarRecursos);
  }

  async function recolectarRecursos() {
    //Cambiar texto boton recolectando
    const { ciudadesConAldeas, tiempoRecoleccion } = data;
    document.getElementById("botonRecolectarRecursos").innerHTML = "...";
    // El tiempo que se pierde esperando entre recoleccion para evitar ban
    let tiempoGastado = ciudadesConAldeas.length * 6 * 1000;

    await recolectarCiudades();

    //se suman diez segundos de margen de error y asegurar recoleccion
    const tiempoEspera =
      tiempoRecoleccion * 60 * 1000 - tiempoGastado + 10 * 1000;

    console.log(`Tiempo Gastado por antiban ${tiempoGastado} en milisegundos`);
    console.log(
      `Tiempo de espera hasta proxima recoleccion ${tiempoEspera} en milisegundos`
    );

    setInterval(recolectarCiudades, tiempoEspera);
  }

  async function recolectarCiudades() {
    const { ciudadesConAldeas } = data;

    for (const ciudad of ciudadesConAldeas) {
      await recolectarCiudad(ciudad);
    }
  }

  const recolectarCiudad = async (ciudad) => {
    const { aldeas } = ciudad;

    for (const aldea of aldeas) {
      await recolectarAldea(ciudad, aldea.id);
    }
  };

  const recolectarAldea = async (ciudad, aldeaId) => {
    const { recursosLlenos, codigoCiudad } = ciudad;
    const { opcionRecoleccion } = data;

    if (recursosLlenos) {
      return;
    }

    //Espera entre recoleccion, para evitar ban
    await delaySeconds(1);

    const json = {
      model_url: "FarmTownPlayerRelation/52287",
      action_name: "claim",
      arguments: {
        farm_town_id: aldeaId,
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

    //Parseo response
    response = response.json.notifications.find(
      (element) => element.subject == "Town"
    );

    response = response.param_str.replaceAll(/\//g, "");

    response = JSON.parse(response);

    response = response["Town"];

    const { storage, last_wood, last_iron, last_stone } = response;

    const indexCiudadActual = data.ciudadesConAldeas.findIndex(
      (ciudadData) => ciudadData.codigoCiudad == codigoCiudad
    );

    data.ciudadesConAldeas[indexCiudadActual].recursosLlenos =
      storage == last_wood && storage == last_iron && storage == last_stone;
  };

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

    console.log({ciudadesJugador});
    ciudadesJugador = ciudadesJugador.json.collections.Towns.data;

    console.log({ciudadesJugador});

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
