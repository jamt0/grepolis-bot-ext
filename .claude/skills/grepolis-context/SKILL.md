---
name: grepolis-context
description: Contexto exhaustivo del juego Grepolis (InnoGames) y del bot JamBot que se desarrolla en este repo. Carga esta skill cuando el usuario mencione cualquier termino del juego (aldea, polis, asalto, colono, favor, maravilla, oro premium, etc.), modos/servidores (es143, VM, VU, revuelta, asedio, dominacion, olimpos/olympus, templos, monte olimpo, divine powers, golden fleece), unidades (hoplita, birreme, manticora...), dioses (Zeus, Atenea, Hera, Ares, Afrodita...), edificios (senado, agora, cueva, templo...), eventos, o features del bot (recoleccion, ataquesEntrantes, mercadoOro, finalizarConstruccion). Tambien cuando hable de "el juego", "el mundo", "mi ciudad", "mis aldeas", "MM", "BP" sin desambiguar — esos terminos siempre se refieren a Grepolis aqui.
---

# Grepolis + JamBot — Contexto unificado

Esta skill da el vocabulario y las reglas del mundo en el que opera el bot que se desarrolla en este repo. El usuario juega Grepolis y construye una extension Chromium (`grepolis-bot-ext`) para automatizar tareas. Cuando hable de "ciudades", "aldeas", "ataques", "oro", "MM", etc., siempre se refiere a este universo — no preguntes que es: usa esta skill.

---

## 1. Que es Grepolis

- MMORTS de navegador (+app movil) de **InnoGames**, lanzado en 2010.
- Ambientacion: **antigua Grecia** y **mitologia olimpica**.
- F2P con moneda premium llamada **oro** (microtransacciones).
- Cada jugador controla **una o varias polis** (ciudades) repartidas en islas dentro de un **mundo** (servidor).
- Objetivo: expandirse, formar alianzas, ganar el mundo por **Maravillas** o **Dominacion**.

---

## 2. Servidores / Mundos

### Nomenclatura
Formato `<prefijo de comunidad><numero incremental>`. **No se reusa numero al cerrar un mundo.**

- `es143`, `es144` → comunidad espanola, mundo N (la del usuario).
- `en…`, `de…`, `fr…`, `pl…`, `it…`, `ar…`, `pt…`, `br…`, `ru…`, `beta…`, etc.
- Cada mundo recibe ademas un nombre tematico (ciudad/isla/deidad griega: Hyele, Olympus, Baris, Side, Upsilon, etc.).

### Velocidades — **siempre son DOS, independientes**
- **VM (Velocidad de Mundo)**: multiplicador (1, 2, 3, 4, hasta 6 en speed). Afecta **produccion de recursos, tiempos de construccion, reclutamiento, generacion de favores**.
- **VU (Velocidad de Unidades)**: separada de VM. Solo afecta **tiempo de viaje** de tropas terrestres y barcos.
- Ejemplo: `VM 2 / VU 2`, `VM 3 / VU 4`. Un mundo puede "producir lento pero mover rapido" o viceversa.

### Configuracion de mundo (parametros que cambian el meta)
- **Tipo de conquista**: **Asedio** (clasico) o **Revuelta** (moderno). Nunca conviven.
- **Moral**: on/off. Si esta activa, atacar a un jugador mucho mas chico tiene poder reducido (hasta -70%).
- **Beginner's Protection**: 5–7 dias iniciales sin posibilidad de ser atacado/espiado.
- **Limite de alianza**: 25 / 35 / 50 / 75 / 100 / 150 / 250 miembros segun mundo.
- **Cuevas**: siempre presentes (mecanica core de espionaje).
- **Tormentas maritimas**: opcionales — pueden retrasar/perder flotas.
- **Heroes**: activos en mundos modernos; obligatorios en "Mundo de Heroes" (solo entran ganadores de otros mundos).
- **Bonus de mundo**: cada mundo nuevo trae bonus al abrir (ej.: +30% poder terrestre, +25% mitica, 3 ciudades iniciales, etc.).

### Ciclo de vida
1. Apertura → expansion → **Era de Maravillas / Dominacion** (a los **180 dias**) → victoria → **14 dias de paz** → cierre/archivado.

### Versiones / variantes
- Clasicos vs modernos (con heroes y MM/Dominacion).
- **Mundo de Heroes** (elite).
- **Speed worlds** (VM 4–6, duran semanas).
- **Beta** (pruebas de features nuevas).

### Mapa
- 100 **oceanos** numerados 00–99 (matriz 10×10). El primer digito de cada coordenada (X,Y) es el oceano.
- Los oceanos centrales (44, 45, 54, 55) son donde arrancan los mundos.
- Cada oceano contiene **muchas islas**; cada isla tiene hasta **8 ciudades** de jugadores y **8 aldeas agricolas**.

---

## 3. Modos de Victoria

### Mundo Maravilla (MM) — clasico
- A los 180 dias arranca la **Era de las Maravillas**.
- Existen **7 Maravillas**: Piramide de Guiza, Jardines de Babilonia, Estatua de Zeus, Templo de Artemisa, Mausoleo de Halicarnaso, Coloso de Rodas, Faro de Alejandria.
- Una alianza necesita **controlar toda una isla** para construir una Maravilla alli.
- Cada Maravilla tiene **10 niveles**, acelerable con favores.
- **Gana** la primera alianza que complete **4 de las 7**. Premio: "Conquistador de X" + **+10% limite de favores**. Si completa las 7: "Maestro de X".

### Dominacion
- Modo alternativo. Tras la era previa, se eligen islas validas (grandes).
- **Objetivo**: una alianza controla el **40%** de las ciudades elegibles.
- Activa la **Resistencia Final**: debe **mantener** ese 40% durante N dias para ganar.

### Olimpos / Olympus — tercer modo de victoria
Modo de fin de partida basado en **conquistar y mantener el Monte Olimpo**. Lanzado **10 de junio de 2020** (nombre interno previo: "Temple Hunt"); revisado en **febrero 2022**. **No reemplaza a Maravillas ni Dominacion** — es un **tercer modo** alternativo. La victoria es **por alianza**.

#### Las 4 fases del mundo Olimpos
1. **Pre-Temple Stage**: los templos pequenos estan en el mapa pero son inconquistables. Las alianzas se posicionan.
2. **Small Temples Stage**: se desbloquea la conquista de **templos pequenos** repartidos por todo el mapa. Cada uno da un **Divine Power** (buff de alianza) que afecta a TODAS las ciudades de TODOS los miembros. Una alianza tiene cupo limitado de templos pequenos simultaneos.
3. **Large Temples Stage**: aparecen **8 templos grandes** en el area exterior del mapa, **uno por dios**: **Zeus, Hera, Poseidon, Atenea, Hades, Artemisa, Ares y Afrodita** (nota: Ares y Afrodita aparecen aqui aunque no son dioses adorables en ciudad normal). Cada templo grande da +50 poblacion en todas las ciudades de la alianza + un buff especifico del dios (ej: Hera −40% tiempo de reclutamiento, Ares +15% velocidad de unidades). Una alianza puede tener **maximo 2 templos grandes** a la vez.
4. **Olympus Stage**: aparece el **Olimpo** en una posicion central. Empieza la carrera final.

#### Reglas de templos
- Conquista **identica a una ciudad** (por asedio). No exige miticas.
- Solo jugadores **en una alianza** pueden conquistar templos (jugador solo no puede).
- Al capturar, el templo recibe **escudo de 24 h** invulnerable.
- Templos **no se pueden espiar**, no tienen recursos saqueables, **no se pueden abandonar**.
- **Templos Portal**: subtipo de templo pequeno que habilita atacar/apoyar el Olimpo a distancia — criticos cuando el Olimpo "salta".

#### Victoria
- Conquistar el **Olimpo** y mantenerlo durante una duracion segun velocidad del mundo:
  - **Rapido**: 38 dias
  - **Normal**: 50 dias
  - **Lento**: 63 dias
- Las **primeras 24 h** post-conquista NO cuentan (escudo).
- **Olympus Jump**: el Olimpo **se reubica periodicamente** (ciclos de 15 / 20 / 25 dias segun velocidad), forzando reconquista.
- **Olympus Curse**: mientras una alianza tiene el Olimpo, **~5% de las unidades defensoras dentro mueren periodicamente** → sangrado constante, obliga a reabastecer.

#### Premios
- **Vellocino de Oro (Golden Fleece)**: recompensa permanente de cuenta — **−10% al coste de reclutar heroes** en futuros mundos.
- **Olympus Champion**: premio extra si la alianza gana **antes del tercer Olympus Jump**.
- Hall of Fame + premios secundarios por conquistas individuales.

### Conquista por # ciudades
- Variante en mundos especiales. Menos comun.

### Tras la victoria (cualquier modo)
- 14 dias de paz total → cierre del mundo → migracion/archivado.
- Recompensas: medallas permanentes, bonus de favor en futuros mundos, acceso a Mundo de Heroes.

### Tabla comparativa de modos de victoria

| Aspecto | Maravillas | Dominacion | Olimpos |
|---|---|---|---|
| Objetivo | Construir 4 de 7 Maravillas | Controlar 40% ciudades + Resistencia Final | Conquistar y mantener el Olimpo |
| Ganador | Alianza | Alianza | Alianza |
| Recurso clave | Recursos masivos + def de isla | Conquista pura + numero de ciudades | Asedio de templos + mantenimiento del Olimpo |
| Buffs durante endgame | No | No | **Si — Divine Powers de templos** |
| Movilidad del objetivo | Estatico | Distribuido | **Olimpo puede saltar de posicion** |
| Inicio de fase final | A los 180 dias | A los 180 dias | Por etapas progresivas (Small → Large → Olympus) |
| Recompensa de cuenta | Medallas / artefactos | Medallas / artefactos | **Vellocino de Oro (−10% coste heroes)** |

---

## 4. Recursos y Edificios

### Recursos
- **Madera** (Aserradero), **Piedra** (Cantera), **Plata** (Mina de plata) — tres recursos materiales.
- **Favor divino** — generado en el Templo segun nivel y dios elegido. Tope 500 (ampliable con Oraculo / Estatua Divina). **Uno por dios**, independiente.
- **Oro** — moneda premium, real $.

### Edificios principales (13)
- **Senado**: central. Habilita el resto y reduce tiempos.
- **Aserradero / Cantera / Mina de plata** (hasta nivel 40).
- **Almacen**: capacidad de recursos + **cantidad oculta** a salvo del saqueo (hasta nivel 30).
- **Granja**: techo de poblacion (max 45).
- **Academia**: investigaciones (max 36, +12 con Biblioteca = 150 puntos).
- **Cuartel**: tropas terrestres (max 30).
- **Puerto**: barcos (max 30).
- **Mercado**: comercio interno y con jugadores (max 30).
- **Cueva**: espionaje y ocultar plata (max 10).
- **Templo**: adoracion (max 30).
- **Muralla**: defensa pasiva 0–25.
- **Agora**: pantalla de gestion de tropas / simulador / revueltas (no se "construye").

### Edificios especiales (eliges 1 por rama, 2 ramas)
- **Rama 1**: Teatro (cultura) / Termas (+poblacion) / Biblioteca (+12 puntos invest.) / Faro (+vel naval).
- **Rama 2**: Torre (def extra) / Estatua Divina (+favor) / Oraculo (detecta espias) / Tienda del mercader (+capacidad comercio).

---

## 5. Ciudades y Aldeas — REGLA CRITICA

- Una **ciudad** (polis) es del jugador. Tiene sus 13 edificios + 8 especiales, tropas, cola de construccion.
- **Cada ciudad tiene SIEMPRE 6 aldeas agricolas asociadas** (farming villages / pueblos agricolas / "BPs" / "farms"). **Esta cardinalidad es fija** — lo que crece con el tiempo es el numero de **ciudades**, no de aldeas por ciudad. El bot asume esto en su logica.
- Las aldeas no se construyen: existen en el mapa de la isla. Se "controlan" para obtener tributos.
- **Acciones sobre una aldea**:
  - **Recolectar / Recoger**: reclamar recursos cada cierto cooldown (5 / 10 / 20 / 90 min / 4h / 8h). Con la investigacion **Lealtad de los aldeanos**, el cooldown rapido pasa de **5 min → 10 min** pero rinde **+115%**. El JamBot detecta esto automaticamente.
  - **Saquear**: tributo instantaneo (cooldown propio).
  - **Comerciar a ratio fijo** (ej. 1:1.25; max 2000 por trueque).
  - **Reclutar tropas** del villorrio (en sistemas avanzados).
- Dos sistemas segun mundo:
  - **Por conquista**: hay que conquistar la aldea con tropas y mantener su "humor". Bajar humor → rebelion → la perdes.
  - **Por puntos de combate** (moderno, estandar hoy): los niveles de aldea se desbloquean acumulando BP.

### Conseguir mas ciudades
- **Fundar** con colonizador en espacio vacio de isla.
- **Conquistar** a otro jugador (asedio o revuelta).
- **Adoptar fantasmas** (jugadores eliminados por inactividad).
- El **limite de ciudades por jugador** sube con **Puntos de Cultura** (festivales, juegos olimpicos, obras teatrales, batallas).

---

## 6. Unidades (27 tipos)

Tres tipos de arma: **golpe (contundente)**, **distancia**, **perforacion (cortante)**. Cada unidad tiene defensa especifica por tipo — combinar tropas es obligatorio.

### Terrestres
| Unidad | Rol | Tipo de ataque |
|---|---|---|
| Espadachin | Defensa | golpe |
| Hondero | Ofensiva barata | distancia |
| Arquero | Defensa distancia | distancia |
| Hoplita | Mixta (def-perforacion); escolta de colono | golpe |
| Jinete | Ofensiva caballo | perforacion |
| Carro | Ofensiva mixta | distancia |
| Gigante (ariete / catapulta) | Asedio (rompe muralla) | golpe |
| Enviado divino | Cultural / fundacion | — |

### Navales (Puerto)
- **Transporte rapido** y **Transporte lento** (mueven tropas terrestres).
- **Birreme** — defensa naval clasica.
- **Brulote (lancha incendiaria)** — suicida anti-flota ofensiva.
- **Trirreme** — naval ofensivo pesado.
- **Colonizador** (alias **TC** / **Colono** / **CS**) — 1 sola unidad para fundar/conquistar.

### Miticas (requieren favor + Templo dedicado a ese dios)
- **Zeus**: Manticora (voladora ofensiva), Minotauro.
- **Atenea**: Pegaso (voladora defensiva), Centauro.
- **Hera**: Harpia (voladora ofensiva), Medusa (def potente).
- **Poseidon**: Hidra (unica **mitica naval**), Ciclope.
- **Hades**: Cerbero (def), Erinia (ofensiva).
- **Artemisa** (mundos recientes): Grifo (voladora), Jabali de Calidon.

**Voladoras** (Pegaso, Grifo, Harpia, Manticora) **no necesitan barco** — cruzan mar solas y pueden apoyar a aliados que adoren al mismo dios.

---

## 7. Dioses y poderes

- Adoracion **un dios por ciudad** a la vez. Cambiar dios cuesta tiempo y favor.
- Hechizos cuestan favor; pueden ser instantaneos o temporales (duracion modulada por VM).

| Dios | Identidad | Hechizos clave |
|---|---|---|
| **Zeus** | Rayo, ofensiva | Colera de Zeus (rayos a tropas entrantes), Llamada del viento, Lluvia de meteoritos, Convocar tropas |
| **Atenea** | Defensa, sabiduria | Fuerza sobrehumana, **Sabiduria** (inmune a ataques divinos mientras dura), Construccion rapida, Heroica |
| **Hera** | Productividad, sabotaje | Bendicion (+recursos), Casarse (+militar), **Manto de invisibilidad** (oculta flota/def), Banquete de la boda |
| **Poseidon** | Mar | Terremoto (dana edificios), **Tormenta marina** (destruye flota entrante), Curacion de aguas, Convocar tropas marinas |
| **Hades** | Muerte | Plaga, Convocar ejercito de muertos, **Anillo de Hades** (oculta tropas), Aumento de fortuna |
| **Artemisa** | Caza | Purificacion (limpia hechizos), Llamada de la naturaleza, Velocidad rapida, Furia |

---

## 8. Combate

### Tipos de operacion
- **Asalto / Ataque** — ofensivo, dispara combate.
- **Conquista** — ataque con **colonizador** (toma la ciudad).
- **Apoyo** — refuerzo a ciudad propia o aliada (no daña).
- **Espionaje** (desde Cueva) — cuesta plata; **plata depositada** en la cueva es la defensa contra espias.

### Calculo de batalla
Ataque del agresor (tipo de arma X) vs defensa del defensor (vs arma X). Modificadores:
- **Muralla** (0–25): % defensa.
- **Defensa basica de ciudad** (constante minima).
- **Fortuna** (suerte): aleatorio **−30% a +30%** al ataque.
- **Moral** (si activa): 100%→30% segun ratio de puntos.
- **Hechizos divinos activos**.
- **Investigaciones** (formacion falange, etc.).
- **Heroe asignado**.

Existe **simulador integrado** en el Agora.

### Mecanica de conquista
- **Asedio** (clasico): el colonizador llega y se **queda 12h** asediando. Defensor puede romperlo enviando tropas que maten al asediador.
- **Revuelta** (moderno): primero un ataque "provoca revuelta" → ventana de **12h en rojo** (en algunas configs 4h sin entrar tropas + ventana posterior). En esa ventana, si el atacante deja la ciudad **vacia de tropas** y mete el colonizador, conquista. **El bot defensor debe detectar la revuelta y o bien vaciar tropas para evitar que entre el colono, o bien defender el espacio con apoyo masivo.**

---

## 9. Heroes (mundos heroicos)

- Asignados **uno por ciudad**.
- Dos tipos:
  - **Battle heroes**: bonus a tropas (ataque/defensa/velocidad). Ej.: Leonidas, Aquiles, Atalanta.
  - **Civil heroes**: bonus economicos (construccion, recursos, favor, comercio). Ej.: Pericles, Cassandra, Telemaco.
- Se reclutan con **monedas de guerra** (battle) o **monedas de sabiduria** (civil), ganadas en **misiones de isla / aventuras**.
- Suben nivel invirtiendo esas monedas. Slots extra desbloqueados por nivel cultural.

---

## 10. Alianzas

- Agrupacion de jugadores. Chat, foro, mapas compartidos, apoyo coordinado.
- **Pactos** entre alianzas:
  - **NAP** (Pacto de no agresion): solo "no atacar".
  - **Hermandad** / pacto de defensa: incluye apoyo militar.
  - **Guerra declarada**: pinta enemigos en rojo en el mapa.
- Las **Maravillas** son construidas por la alianza.

---

## 11. Eventos recurrentes

- **Grepolympia** (Juegos Olimpicos): carrera de hoplitas, tiro con arco, lanzamiento de jabalina, carreras de carros. 3 dias por disciplina.
- **Oktoberfest** (sept-oct).
- **Halloween / Noche Cero** (oct-nov).
- **Festival de Navidad** (dic).
- **Festival de San Valentin / del Amor** (feb).
- **Aventuras**: misiones cortas en islas → monedas para heroes.
- **Tesoros / Cofres**: recompensas diarias / por eventos.

Cada evento tiene **moneda temporal** + tienda exclusiva.

---

## 12. Glosario rapido (siglas y jerga ES)

Lista de terminos comunes en la comunidad hispanohablante. Cuando el usuario use uno, **no preguntar** — esto es lo que significa.

- **Polis** = ciudad propia.
- **Aldea / BP / pueblo agricola / farm** = farming village. **Siempre 6 por ciudad**.
- **MM** = Mundo Maravilla / Maravilla del Mundo.
- **Olimpos / Olympus / Monte Olimpo** = tercer modo de fin de mundo. Se conquistan templos repartidos en el mapa y luego el Olimpo central. Lanzado 2020.
- **Templo pequeno / small temple** = templo conquistable que da un **Divine Power** (buff de alianza). Hay muchos en el mapa.
- **Templo grande / large temple** = uno de los **8 templos** (Zeus, Hera, Poseidon, Atenea, Hades, Artemisa, Ares, Afrodita) en area exterior; max 2 por alianza.
- **Templo Portal** = templo pequeno especial que permite atacar/apoyar el Olimpo a distancia.
- **Divine Power / Poder Divino (de templo)** = buff pasivo que da un templo controlado a toda la alianza. **No confundir** con los "Poderes Divinos" / hechizos clasicos del Templo de adoracion (Colera de Zeus, Manto, Terremoto, etc.) — son conceptos distintos que comparten nombre.
- **Olympus Jump / salto del Olimpo** = reubicacion automatica del Olimpo cada 15/20/25 dias segun velocidad — resetea la presion defensiva.
- **Olympus Curse / Maldicion del Olimpo** = ~5% de unidades defensoras dentro del Olimpo mueren periodicamente mientras lo controles.
- **Vellocino de Oro / Golden Fleece** = recompensa por ganar mundo Olimpos: −10% coste de reclutar heroes en futuros mundos.
- **Olympus Champion** = premio extra si tu alianza gana antes del 3er Olympus Jump.
- **Temple Hunt** = nombre interno previo del modo Olimpos durante desarrollo (2019-2020).
- **BP** = Puntos de Batalla (ranking por matar unidades). **Tambien** se usa para aldea en algunos foros — desambiguar por contexto.
- **PC** = Puntos de Cultura.
- **TC** = Transportador Colonial = **colonizador / colono / CS** (barco que conquista).
- **Asalto** = ataque ofensivo.
- **Apoyo** = enviar def a aliado.
- **Cueva** = espionaje.
- **Favor** = recurso divino del Templo.
- **Agora** = vista de gestion de tropas.
- **Muralla** = defensa pasiva (0–25).
- **Maravilla** = obra de alianza, fin de mundo.
- **NAP** = pacto de no agresion.
- **BM** = "birremes manto" — flota defensiva oculta con **Manto de invisibilidad** de Hera, lista para **snipe**.
- **Snipe** = defensa de precision: refuerzo timing-perfect entre dos waves enemigas para matar el colono del segundo hit.
- **Wave / Oleada** = serie de ataques sincronizados a una misma ciudad.
- **Hit** = un ataque concreto dentro de una wave.
- **Dodge** = sacar tropas/flota justo antes del impacto.
- **Front / Frente** = ciudades cerca del enemigo. Opuesto a **Nucleo / Core / Corazon** (ciudades centrales lejos del frente).
- **Def gen / Def general** = mix balanceado (hoplitas + espadachines + arqueros) que aguanta cualquier tipo de daño.
- **Def especifica** = especializada por tipo de arma esperada.
- **LS** = jerga importada de Tribal Wars. **En Grepolis no hay "lanceros"** — cuando alguien dice "LS" suele referirse a **honderos** (slinger) o, mas raro, a hoplitas. Pedir aclaracion si es dudoso.
- **DLS** = NO aplica en Grepolis (Tribal Wars). No usar.
- **Mercado de oro / Premium Exchange** = mercado donde se cambia oro premium por recursos. Tiene **stock/capacidad por mar**. Ratios fluctuan.
- **Ratio** (en mercado oro) = oro necesario para 1 unidad de recurso.
- **Inactivo / Fantasma** = jugador que dejo de loguearse; sus ciudades son target facil.
- **Tributos / Demanda de aldea** = lo que la aldea pide para subir nivel.
- **Lealtad de los aldeanos** = investigacion que duplica cooldown rapido (5→10 min) pero rinde +115%.

---

## 13. JamBot — el bot que se desarrolla aqui

Extension **Chromium Manifest V3** que automatiza tareas dentro del cliente web del juego. **Solo actua en `*.grepolis.com`** (excluye foros y wikis).

### Arquitectura
- `manifest.json` — content scripts en orden: `core.js` → `features/recoleccion.js` → `features/finalizarConstruccion.js` → `features/ataques.js` → `features/ataquesEntrantes.js` → `features/mercadoOro.js` → `contentScript.js`.
- Recursos `web_accessible_resources`: `data.json` (config), `js/saveToken.js` (extrae CSRF), `js/gameBridge.js` (puente a `window.Game` del page-context).
- Todo el estado vive en `chrome.storage.local`. **No hay backend.**
- **Namespaceo por `world_id`**: todas las claves de storage incluyen `_${world_id}` para no contaminar entre mundos.

### `core.js` — fundacion
- `window.JamBot.core` + `window.JamBot.features.<nombre>`.
- Cada feature recibe `ctx = { data, game:{csrfToken, world_id, townId, player_id}, core:{...} }`.
- Logging unificado (`log`/`logWarn`/`logError`/`logCiclo`) con timestamp, colores, buffer en memoria (`MAX_ERRORES=200`) persistido con throttle de 500ms en `jambotErrores`. Disponible en DevTools como `JamBot.errores()`.
- Captura global de `error` / `unhandledrejection` filtrada por prefijo de extension.
- **Deteccion de contexto invalidado** (`isExtensionContextValid`): cuando se recarga la extension, el content-script viejo queda huerfano → loguea **una sola vez** y pausa.
- **Estado de CAPTCHA** — maquina de 3 estados (`none/pending/timeout`):
  - Cuando una request "huele a CAPTCHA" (no llega notificacion esperada) → `pending`.
  - **Detiene TODO**, timeout 10 min, flashea titulo de pestaña, beep agudo 880 Hz, muestra carton "Ya resolvi".
  - El bridge avisa cuando `Game.bot_check` vuelve a null (humano resolvio en el juego) pero **NO reanuda solo** — requiere click explicito.
- **Play/pause global** (`isPaused`/`setPaused`/`togglePlayPause`): arranca **pausado**. Cada feature se suscribe con `onPlayPauseChange`. `setPaused` imprime `console.trace` para auditar quien pausa.
- UI: contenedor `#jambot-buttons` posicionado `bottom:120px; left:80px; z-index:5` (z-index bajo deliberadamente para no tapar modales del juego).
- Helpers: `delaySeconds`, `formatDuracion`, `sonarAlerta` (880 Hz, captcha), `sonarAdvertencia` (660→440 Hz, ciudad llena/cupo).
- `init()` lee `localStorage.game` (csrf + world + town + player), inyecta `saveToken.js` + `gameBridge.js`, escucha `JamBot:captchaState` y devuelve `ctx`.

### Cadencia y politica del proyecto (memoria)
- **Jitter fijo 2-2.5 s** entre acciones. **No proponer cadencia adaptativa, ni rotacion, ni jitter dinamico** — esta regla esta en la memoria del usuario.

### Features

#### `features/recoleccion.js`
Recolecta recursos de las **6 aldeas de cada ciudad** ejecutando el boton "Recoger" rapido. Detecta automaticamente el cooldown leyendo `lootable_at - last_looted_at` del modelo `FarmTownPlayerRelation` (5 min sin Lealtad, 10 min con Lealtad). Persiste `lastClaimAtPorAldea` namespaceado por `world_id`. Historial FIFO `HISTORIAL_MAX=36` por aldea, `CICLOS_MAX=36` ciclos. Mezcla orden de aldeas por ciclo, hasta 3 reintentos por borde de cooldown. **Distingue "almacen lleno" (success:true sin notif `Town`) de CAPTCHA real** cacheando `storageCap` por ciudad.

#### `features/finalizarConstruccion.js`
Aprovecha el boton **Gratis** nativo del juego: cuando una orden de construccion entra en la ventana **<5 min** (usa 290 s de margen) dispara `frontend_bridge action=execute → BuildingOrder.buyInstant`. Lee la cola de **todas** las ciudades via MM (modelos del cliente). Reagenda segun la proxima orden que entre en ventana (no polling innecesario). Persiste `ultimoCiclo` + ultimas `FINALIZADAS_MAX=20` ordenes. **Toggle independiente del play/pause global.**

#### `features/ataques.js`
Envia ataques periodicos round-trip desde cada ciudad propia a un target. Lista cerrada `TIPOS_UNIDAD` de 27 unidades. Por ciclo: consulta unidades disponibles con `JamBot:queryUnits`, manda todo lo disponible del tipo elegido con `POST /town_info?action=send_units`, lee `started_at`/`arrival_at` de la notificacion `MovementsUnits` y reagenda a `2*(arrival_at - started_at) + 20s` de margen. Config independiente por ciudad (target, tipos, on/off, modo spam). Boton Iniciar/Detener propio en tab "Ataques". Los timers se cancelan tambien con play/pause global o CAPTCHA.

#### `features/ataquesEntrantes.js`
**Alarma defensiva persistente.** Poll cada **10s** del endpoint `town_overviews:command_overview` (una sola request da vista global de TODAS las ciudades). Filtra commands con `!cmd.return && attack_types[cmd.type] && destination_town_player_id == me`. Tipos:
- **Criticos**: `attack_takeover`, `revolt` (conquista).
- **Normales**: `attack`, `attack_land`, `attack_sea`, `illusion`, `portal_*`.

Cuando aparece un id nuevo no ack: beep cada 700 ms + flash de titulo. Silencia con boton "🔔 Revise ataques" → marca los ids actuales como ack. Si entra OTRO ataque despues, vuelve a sonar. `ackIds` persiste namespaceado y se autopurga cuando el id desaparece del server. **Corre aunque el bot este pausado, pero respeta CAPTCHA.**

#### `features/mercadoOro.js`
Monitorea el **mercado de oro premium**. Poll cada **3s** (bajado recientemente de 60→20→3 para reaccion mas rapida) sobre `PremiumExchange:read` en una ciudad representante por **mar** (`sea_id`). Estrategia "1 ciudad por mar": primera ronda mapea `sea_id → townId`, regimen estable solo poll a representantes, re-descubre cada 30 min. Alarma cuando `capacity - stock >= UMBRAL=100` en madera/piedra/hierro de algun mar — beep 700 ms + flash + boton "🔔 Revise oro" (visible solo durante alarma). Cada mar es independiente: `maresEnAlarma` y `maresMuteados` por seaId. **Independiente del play/pause global, respeta CAPTCHA.**

### Convenciones transversales
- Todas las keys de storage van con sufijo `_${world_id}`.
- **Cada ciudad SIEMPRE tiene 6 aldeas** — el bot asume esa cardinalidad. Lo que escala es el numero de ciudades.
- Comunicacion con el juego: `gameBridge.js` (postMessage al page-context) o endpoints HTTP capturados (`town_info`, `frontend_bridge`, `town_overviews`, `PremiumExchange`).
- **El bot arranca pausado** despues de cada reload — usuario tiene que apretar ▶ Iniciar.

---

## 14. Como usar esta skill

- Cuando el usuario diga **"mis aldeas"**, **"mi ciudad"**, **"el mundo"**, **"MM"**, **"BP"**, **"oro"**, **"colono"**, **"revuelta"**, **"asedio"**, **"hoplita"**, **"birreme"**, **"manticora"**, **"favor"**, **"agora"**, **"cueva"**, etc. — ya sabes el contexto. No pidas aclaracion.
- Cuando hable de **una feature del bot** (recoleccion, ataques, ataques entrantes, mercado de oro, finalizar construccion) — usa la descripcion de la seccion 13 como base para razonar sobre el codigo.
- Cuando hable de **modificar comportamiento del bot** — recorda la regla de cadencia fija 2-2.5s (memoria del usuario) y la cardinalidad de 6 aldeas por ciudad.
- Cuando aparezca un termino ambiguo (**LS**, **TC**, **BP**) — desambiguar por contexto o preguntar especificamente.
- Cuando el usuario describa una **mecanica del juego**, podes mapearla directo a esta skill sin re-investigar.

---

## Fuentes de referencia (validacion externa)
- https://wiki.es.grepolis.com/wiki/P%C3%A1gina_principal — wiki oficial ES (puede tener anti-bot a fetch automatico).
- https://wiki.en.grepolis.com/wiki/Main_Page — wiki oficial EN.
- https://es.forum.grepolis.com — foro oficial ES.
- https://www.innogames.com/games/grepolis/ — pagina oficial del juego.
