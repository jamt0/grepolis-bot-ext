(async () => {
  //Importar save token
  injectScript(chrome.runtime.getURL("/js/saveToken.js"), "body");
  let hToken;
  let worldId;

  //Importar json data
  let data = await fetch(chrome.runtime.getURL("/data.json"));
  data = await data.json();

  //Esperando que se carge la variables de saveToken para insertar el boton
  window.addEventListener(
    "message",
    (event) => {
      if (event.source != window) {
        return;
      }

      if (event.data.type && event.data.type == "FROM_PAGE") {
        worldId = event.data.world_id;
        hToken = event.data.h_token;
        insertarBotonDeRecolectarRecursos();
      }
    },
    false
  );

  function insertarBotonDeRecolectarRecursos(params) {
    const botonRecolectarRecursos = document.createElement("button");
    botonRecolectarRecursos.innerHTML = "Recolectar aldeas nuevo mundo";
    botonRecolectarRecursos.id = "botonRecolectarRecursos";
    botonRecolectarRecursos.style.cssText +=
      "position:absolute;bottom:140px;left:10px;z-index:1000";
    document.body.appendChild(botonRecolectarRecursos);
    botonRecolectarRecursos.addEventListener("click", recolectarRecursos);

  }

  async function recolectarRecursos() {
    const { ciudadesConAldeas, tiempoRecoleccion } = data;
    document.getElementById("botonRecolectarRecursos").innerHTML =
      "Recolectando aldeas nuevo mundo...";
    // El tiempo que se pierde esperando entre recoleccion para evitar ban
    let tiempoGastado = ciudadesConAldeas.length * 6 * 60;
    await recolectarRecursosCiudades();
    setInterval(recolectarRecursosCiudades, tiempoRecoleccion - tiempoGastado);
  }

  async function recolectarRecursosCiudades() {
    const { ciudadesConAldeas } = data;

    for (const ciudad of ciudadesConAldeas) {
      await recolectarRecursosAldeasCiudad(ciudad);
    }
  }

  const recolectarRecursosAldeasCiudad = async (ciudad) => {
    const { numeroAldeas } = data;

    for (let index = 0; index < numeroAldeas; index++) {
      await recolectarRecursosAldea(ciudad, index);
    }
  };

  const recolectarRecursosAldea = async (ciudad, index) => {
    const { codigoAldeaInicial, codigoCiudad, active, recursosLlenos } = ciudad;
    const { opcionRecoleccion } = data;

    if (!active || recursosLlenos) {
      return;
    }

    //Espera entre recoleccion, para evitar ban
    await delaySeconds(1);

    const json = {
      model_url: "FarmTownPlayerRelation/52287",
      action_name: "claim",
      arguments: {
        farm_town_id: codigoAldeaInicial + index,
        type: "resources",
        option: opcionRecoleccion,
      },
      town_id: codigoCiudad,
      nl_init: true,
    };

    const datos = new URLSearchParams();

    datos.append("json", JSON.stringify(json));

    let response = await fetch(
      `https://${worldId}.grepolis.com/game/frontend_bridge?town_id=${codigoCiudad}&action=execute&h=${hToken}`,
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

  //TODO: Hacer que actualice la interfaz
  //TODO: Obtner datos (codigo ciudad y aldeas) desde solicitudes o interfaz
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
