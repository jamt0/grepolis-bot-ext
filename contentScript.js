(async () => {
  
  let data = await fetch(chrome.runtime.getURL('/data.json'));
  data = await data.json();
  
  //Insetar boton en la interfaz
  const injectElement = document.createElement("button");
  injectElement.innerHTML = "Recolectar aldeas";
  injectElement.id = "botonIniciarRecoleccion";
  injectElement.style.cssText +=
    "position:absolute;bottom:80px;left:10px;z-index:1000";
  document.body.appendChild(injectElement);

  injectElement.addEventListener("click", recolectarRecursos);

  async function recolectarRecursos() {
    const { ciudadesConAldeas, tiempoRecoleccion } = data;
    document.getElementById("botonIniciarRecoleccion").innerHTML = "Recolectando aldeas...";
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

  //TODO: LLevar a coolfunctions
  function delaySeconds(seconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, seconds * 1000);
    });
  }

  const recolectarRecursosAldea = async (ciudad, index) => {
    const { codigoAldeaInicial, codigoCiudad, active } = ciudad;
    const { opcionRecoleccion } = data;

    if (!active) {
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

    await fetch(
      `https://es108.grepolis.com/game/frontend_bridge?town_id=${codigoCiudad}&action=execute&h=${data.h}`,
      {
        method: "POST",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          accept: "text/plain, */*; q=0.01",
        },

        body: datos,
      }
    );
  };

  //TODO: Hacer que actualice la interfaz
  //TODO: Obtner datos (codigo ciudad y aldeas) desde solicitudes o interfaz
  //TODO: poner limite para las noches
})();
