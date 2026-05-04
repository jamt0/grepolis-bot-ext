# Panel UI

El panel **JamBot** centraliza la configuración y la observabilidad del bot. Se abre desde la card "Jam" flotante (esquina inferior izquierda, al lado del pulpo del juego). Implementado en [`features/recoleccion.js`](../features/recoleccion.js) (todo el bloque del panel; aunque visualmente expone también datos de `finalizarConstruccion`, vive en el archivo de recoleccion porque allí se inicializa la card abridora).

---

## 1. Layout y posicionamiento

```
position: absolute
bottom:   160px       (encima de la cola de construcción del juego)
left:     50%
transform: translateX(-50%)        (centrado horizontal)

width:    70vw                     (con min 460px y max 900px)
height:   70vh                     (max calc(100vh - 190px))

z-index:  9999                     (encima de modales del juego)

display:  flex
flex-direction: column
```

Estructura interna (tres rows fijos arriba + un row flex):

```
┌─────────────────────────────────────────┐
│ JamBot                              ✕   │  ← .pcj-titulo (fijo)
├─────────────────────────────────────────┤
│ [● Corriendo]  próximo en 7m 32s   [⏸] │  ← #panelHeaderEstado (fijo)
├─────────────────────────────────────────┤
│ [Dashboard][Settings][Recolección][...] │  ← .pcj-tabs (fijo)
├─────────────────────────────────────────┤
│ ╔═══════════════════════════════════╗   │  ← .pcj-body
│ ║ contenido del tab                 ║   │     flex:1 + min-height:0
│ ║ activo                            ║   │     overflow-y:auto
│ ║ scrolleable                       ║   │
│ ╚═══════════════════════════════════╝   │
└─────────────────────────────────────────┘
```

El header de estado lleva el botón de play/pause integrado (antes era un botón flotante separado). El pill de la izquierda cambia según el estado: azul "Corriendo", verde "Pausado", rojo "CAPTCHA" (botón Iniciar deshabilitado), gris "TIMEOUT" (botón habilitado — limpia el captcha y arranca un ciclo nuevo).

El truco para que el body scrollee correctamente es la combinación `flex:1 + min-height:0 + overflow-y:auto`. Sin `min-height:0` el flex item nunca achica abajo del contenido y el scroll no aparece.

---

## 2. Cómo se abre/cierra

| Acción | Comportamiento |
|--------|----------------|
| Click en la card **Jam** (esquina inferior izquierda) | Toggle. Si está cerrado, abre en el último tab activo (default Dashboard, o Recolección si hay CAPTCHA pendiente). Si está abierto en el mismo tab destino, cierra. |
| Click en ✕ del header | Cierra. |
| Click en cualquier lugar fuera del panel | Cierra. |

El "click outside" usa `document.addEventListener("mousedown", h, true)` (capture phase) — se ejecuta antes que el click handler de la card. El handler tiene 2 escapes:
- Si el target está dentro del panel → no cerrar.
- Si el target está dentro de la card Jam → no cerrar (el toggle de la card hace lo suyo, evitamos abrir-cerrar-abrir en el mismo click).

Al cerrar se cancela el `setInterval` del auto-refresh para no gastar CPU mientras el panel no se ve.

---

## 3. Auto-refresh

Mientras está abierto, un `setInterval` cada 1s:
1. Repinta el header (countdown del próximo ciclo + countdown del timeout de CAPTCHA si aplica).
2. Si el tab activo es **Dashboard**, **Recolección** o **Construcción**, repinta el body completo (los countdowns y progreso son dinámicos).
3. Si el tab activo es **Settings**, no repinta (es estático).

El re-render completo es aceptable acá porque el contenido es chico (decenas de elementos). Si en el futuro llegamos a 50+ ciudades con todas expandidas, conviene hacer diff manual o capear a 2-5s.

---

## 4. Tab persistente

```js
window.localStorage.setItem("jambotTabActivo", "recoleccion");
```

Se guarda al cambiar de tab y se restaura al abrir el panel. Sobrevive a reload de la pestaña. Tabs válidos: `dashboard`, `settings`, `recoleccion`, `construccion`. Si el valor guardado no está en esa lista, cae a `dashboard` (default).

---

## 5. Tabs

### Dashboard
Tab por default — vista resumen "de un golpe de vista":
- Totales del último ciclo (claims, recursos, completitud).
- Próximo tick (countdown) y estado de la feature de recolección.
- Estado de la feature de construcción (cuántas órdenes en cola, próxima en ventana).
- Últimos errores y warnings filtrados a las features.

Pensado como tab de "abrí el panel solo para mirar": no necesitás bajar a Recolección para ver si todo viene bien.

### Settings
- Toggle "Finalizar construcción gratis" (lee/escribe `chrome.storage.local.jambotConfig.finalizarHabilitado`; la feature `finalizarConstruccion` escucha `chrome.storage.onChanged` y reacciona automáticamente).
- Lista de ciudades con select 5/10 min. Al cambiar, persiste en `jambotConfig.porCiudad[codigoCiudad]`.
- Sección "Mantenimiento":
  - **Limpiar historial** → confirma → vacía `historialPorAldea` + `ciclos` y borra `jambotHistorial_${world_id}` del storage.
  - **Exportar JSON** → genera un `Blob` con `{world_id, exportadoEn, ciclos, porAldea}` y dispara descarga `jambot-historial-{world_id}-{YYYY-MM-DD}.json`.
  - **Reset cooldown server** → confirma → vacía `lastClaimAtPorAldea` y borra `jambotLastClaimAt_${world_id}`. Útil solo para debugging — el bot vuelve a sincronizar solo en el próximo ciclo via `aldea.loot`.

### Recolección
Hasta seis secciones (la primera solo aparece bajo CAPTCHA):

1. **Cartel CAPTCHA** (solo cuando `core.isCaptchaActive()`). Pinned arriba del tab. Pinta de:
   - **Rojo** en estado `pending`: muestra ciclo + ciudad/aldea que falló, lista de pendientes en cola, countdown del timeout (10 min) y botón **"Ya resolví"**.
   - **Verde** cuando el bridge ya detectó que `Game.bot_check` se limpió en el juego (flag `resueltoEnJuego`): el botón se resalta y cambia el copy.
   - **Gris** en estado `timeout`: pasaron 10 min sin click, cartel informa que el bot está detenido y que apretar Iniciar arranca un ciclo limpio.
   El botón "Ya resolví" llama `resolverCaptchaPorUsuario()`: refresca `island_info` de cada ciudad, reconcilia `lastClaimAtPorAldea` con los `loot` del server (detecta claims que hizo el humano), llama `core.onCaptchaResuelto()` y programa un tick inmediato.
2. **Ciclo en curso** (solo si hay uno corriendo). Naranja. Header con icono `↻`, título `Ciclo #N en curso` y badge de ratio `A/B aldeas`. Resumen por ciudad con progreso parcial.
3. **Último ciclo**. Verde si fue completo (todas las ciudades a 6/6), rojo si quedó incompleto. Header con icono ✓/✗, título, badge de ratio y hora+duración a la derecha (todos los headers de ciclo usan `headerCiclo()` para layout consistente).
4. **Ciclos anteriores** (colapsable, cerrado por default). Lista los ciclos persistidos excepto el último. Cada uno es una tarjeta colapsable con el mismo formato.
5. **Aldeas e historial**. Lista de ciudades. Cada ciudad expande sus 6 aldeas. Cada aldea expande su historial de 36 últimas recolecciones — timestamp, recursos, status, número de ciclo. Las ciudades con tanda incompleta en el último ciclo se abren expandidas por default.
6. **Errores y warnings recientes** (colapsable, cerrado por default). Lee del buffer global filtrado a las últimas 15 entradas. Botón "Limpiar buffer" llama `core.clearErrores()`.

### Construcción
Cinco secciones:

1. **Header de estado** (no colapsable). Muestra estado (Activa / Pausada / Deshabilitada) + countdown del próximo tick.
2. **Último ciclo** de finalización. Resumen con: órdenes en cola, en ventana free, finalizadas, duración.
3. **Cola actual** (colapsable, abierto). Todas las órdenes pendientes en cualquier ciudad, ordenadas por tiempo restante. Las que ya entraron en la ventana de free-finish (≤290s) llevan badge naranja `⏱`.
4. **Últimas finalizadas** (colapsable, abierto). FIFO de las últimas 20 órdenes finalizadas exitosamente.
5. **Errores y warnings de finalizar** (colapsable, cerrado). Filtrado a `scope:"finalizar"` del buffer global.

---

## 6. Componente "seccionColapsable"

Helper genérico usado por todas las tabs:

```js
seccionColapsable(headerTexto, expandido, setExpandido, renderContenido, colorAcento)
```

- Renderiza un header clickeable con borde izquierdo del color acento.
- El contenido se construye **lazy**: `renderContenido()` solo se llama cuando está expandido. Eso evita renderizar 50 ciudades × 6 aldeas × historial al abrir el panel.
- `setExpandido(bool)` persiste el estado (en memoria, en `uiColapso`). No se guarda en storage — al recargar vuelve a defaults.

---

## 7. Card "Jam" (fuera del panel)

La card flotante en `#jambot-buttons` (esquina inferior izquierda, `bottom:45px;left:80px` — al lado del pulpo del juego) es el único elemento visible cuando el panel está cerrado. Funciona como "abridor" del panel + indicador de estado.

Estructura:

```
┌────────────────────────────────┐
│ [slime SVG]  Jam  <icono>  <X> │
└────────────────────────────────┘
```

- **Slime SVG**: blob verde inline. No depende de assets externos.
- **Label "Jam"**: fijo, identificación visual.
- **Icono de estado** (`#jambot-card-estado`):
  - `▶` verde → bot pausado.
  - vacío → bot corriendo (el countdown / spinner indica actividad — antes mostraba `⏸` pero confundía).
  - `⚠` rojo → CAPTCHA pendiente.
  - `⏱` gris → CAPTCHA en timeout.
- **Indicador secundario** (`#jambot-card-countdown`):
  - countdown formateado (`5m 12s`) → próximo ciclo.
  - spinner CSS naranja (`.jambot-spinner`, animación `jb-spin` 0.8s linear) → ciclo en curso. Reemplaza el viejo `N/M aldeas` — más limpio y no compite con el countdown.
  - nombre de la aldea que disparó CAPTCHA → durante CAPTCHA pendiente, así sabés a qué ir.
- **Borde** rojo / verde / gris según el estado de CAPTCHA (ver tab Recolección).
- **Tooltip**: `CAPTCHA · <ciudad> → <aldea> (click para resolver)` cuando hay CAPTCHA activo.

Click en la card abre el panel. Default: tab Dashboard. Excepción: si hay CAPTCHA pendiente, abre directo en Recolección (donde está el botón "Ya resolví").

Repintado: un `setInterval(actualizarEstadoCard, 1000)` siempre activo (es barato y simplifica el ciclo de vida — no hay que arrancarlo/pararlo según estado). Además, los listeners `core.onCaptcha()` y `core.onCaptchaContextChange()` disparan repintados inmediatos por evento.

---

## 8. Estilos

Convenciones de color usadas en todo el panel (alineadas con `core.js`):

| Color | Uso |
|-------|-----|
| `#27ae60` verde | Éxito (claim ok, ciclo completo) |
| `#e74c3c` rojo | Falla (tanda incompleta, error) |
| `#f39c12` ámbar | En progreso, advertencia, en ventana free |
| `#3498db` azul | Info, header de ciudad, tab activo |
| `#9b59b6` violeta | Header de ciclo |
| `#8a96a6` gris | Estado neutro, etiquetas, separadores |

Tipografía: `Segoe UI` 12px (texto general) y `monospace` 10.5-11px (filas de datos). El monospace alinea verticalmente los deltas / timestamps / contadores.

---

## 9. Ver también

- [arquitectura.md](arquitectura.md) — cómo encaja el panel en el bootstrap.
- [recoleccion.md](recoleccion.md) — qué hace el ciclo cuyos datos muestra el panel.
- [persistencia.md](persistencia.md) — qué se guarda en `localStorage` y `chrome.storage.local`.
- [logging.md](logging.md) — el buffer de errores que alimenta la sección "Errores recientes".
