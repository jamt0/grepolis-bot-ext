// El numero de la aldea inicial debe ser el menor
const data = {
  numeroAldeas: 6,
  opcionRecoleccion: 1,
  ciudadesConAldeas: [
    {
      nombreCiudad: "Jam3",
      codigoAldeaInicial: 985,
      codigoCiudad: 4104,
      active: true,
    },
    {
      nombreCiudad: "Jam5",
      codigoAldeaInicial: 1171,
      codigoCiudad: 5574,
      active: true,
    },
    {
      nombreCiudad: "Jam8",
      codigoAldeaInicial: 1555,
      codigoCiudad: 4964,
      active: true,
    },
    {
      nombreCiudad: "Jam9",
      codigoAldeaInicial: 1519,
      codigoCiudad: 4951,
      active: true,
    },
    {
      nombreCiudad: "Jam11",
      codigoAldeaInicial: 1315,
      codigoCiudad: 4313,
      active: true,
    },
    {
      nombreCiudad: "Jam14",
      codigoAldeaInicial: 1729,
      codigoCiudad: 5682,
      active: true,
    },
    {
      nombreCiudad: "Jam15",
      codigoAldeaInicial: 1747,
      codigoCiudad: 5606,
      active: true,
    },
    {
      nombreCiudad: "Jam16",
      codigoAldeaInicial: 1009,
      codigoCiudad: 3326,
      active: true,
    },
    {
      nombreCiudad: "Jam17",
      codigoAldeaInicial: 1087,
      codigoCiudad: 4401,
      active: true,
    },
    {
      nombreCiudad: "Jam18",
      codigoAldeaInicial: 1735,
      codigoCiudad: 5616,
      active: true,
    },
    {
      nombreCiudad: "Jam19",
      codigoAldeaInicial: 1801,
      codigoCiudad: 8418,
      active: true,
    },
    {
      nombreCiudad: "Jam20",
      codigoAldeaInicial: 1375,
      codigoCiudad: 5483,
      active: true,
    },
    {
      nombreCiudad: "Jam21",
      codigoAldeaInicial: 2179,
      codigoCiudad: 6925,
      active: true,
    },
    {
      nombreCiudad: "Jam22",
      codigoAldeaInicial: 1735,
      codigoCiudad: 8427,
      active: false,
    },
    {
      nombreCiudad: "Jam23",
      codigoAldeaInicial: 1375,
      codigoCiudad: 5477,
      active: false,
    },
    {
      nombreCiudad: "Jam24",
      codigoAldeaInicial: 1267,
      codigoCiudad: 6020,
      active: true,
    },
    {
      nombreCiudad: "Jam25",
      codigoAldeaInicial: 1801,
      codigoCiudad: 8436,
      active: false,
    },
    {
      nombreCiudad: "Jam26",
      codigoAldeaInicial: 2017,
      codigoCiudad: 8468,
      active: true,
    },
    {
      nombreCiudad: "Jam27",
      codigoAldeaInicial: 1513,
      codigoCiudad: 4841,
      active: true,
    },
  ],
};

(() => {
  //Insetar boton en la interfaz
  const injectElement = document.createElement("button");
  injectElement.innerHTML = "Recolectar aldeas";
  injectElement.style.cssText +=
    "position:absolute;bottom:30px;left:10px;z-index:1000";
  document.body.appendChild(injectElement);

  injectElement.addEventListener("click", recolectarRecursosCiudades);

  function recolectarRecursosCiudades() {
    const { ciudadesConAldeas } = data;
    
    ciudadesConAldeas.forEach(async (ciudad) => {
      await recolectarRecursosAldeasCiudad(ciudad);
    });
  }

  //TODO: recolectar recursos cada 10 min despues de oprimir el boton

  const recolectarRecursosAldeasCiudad = async (ciudad) => {
    const { numeroAldeas } = data;
    for (let index = 0; index < numeroAldeas; index++) {
      await recolectarRecursosAldea(ciudad, index);
    }
  };

  const recolectarRecursosAldea = async (ciudad, index) => {
    const { codigoAldeaInicial, codigoCiudad, active } = ciudad;
    const { opcionRecoleccion } = data;

    if (!active) {
      return;
    }

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

    //TODO: Si es variable h, de donde se consigue?
    await fetch(
      `https://es108.grepolis.com/game/frontend_bridge?town_id=${codigoCiudad}&action=execute&h=5b5431dc294833019a2fe8896edd472f07041e2a`,
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
})();
