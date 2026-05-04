# Panel UI

El panel ⚙ centraliza la configuración y la observabilidad del bot. Implementado en [`features/recoleccion.js`](../features/recoleccion.js) (todo el bloque del panel; aunque visualmente expone también datos de `finalizarConstruccion`, vive en el archivo de recoleccion porque allí se inicializa el botón ⚙).

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
┌──────────────────────────────┐
│ JamBot                    ✕  │  ← .pcj-titulo (fijo)
├──────────────────────────────┤
│ Estado: ⏸ Corriendo         │  ← #panelHeaderEstado (fijo)
│ Próximo ciclo: 7m 32s        │
├──────────────────────────────┤
│ [Settings][Recolección][Cons.]│ ← .pcj-tabs (fijo)
├──────────────────────────────┤
│ ╔════════════════════════╗   │  ← .pcj-body
│ ║ contenido del tab      ║   │     flex:1 + min-height:0
│ ║ activo                 ║   │     overflow-y:auto
│ ║ scrolleable            ║   │
│ ╚════════════════════════╝   │
└──────────────────────────────┘
```

El truco para que el body scrollee correctamente es la combinación `flex:1 + min-height:0 + overflow-y:auto`. Sin `min-height:0` el flex item nunca achica abajo del contenido y el scroll no aparece.

---

## 2. Cómo se abre/cierra

| Acción | Comportamiento |
|--------|----------------|
| Click en ⚙ | Toggle (abre si está cerrado, cierra si está abierto). |
| Click en ✕ del header | Cierra. |
| Click en cualquier lugar fuera del panel | Cierra. |

El "click outside" usa `document.addEventListener("mousedown", h, true)` (capture phase) — se ejecuta antes que el click handler del botón ⚙. El handler tiene 2 escapes:
- Si el target está dentro del panel → no cerrar.
- Si el target está dentro del botón ⚙ → no cerrar (el toggle del botón hace lo suyo, evitamos abrir-cerrar-abrir en el mismo click).

Al cerrar se cancela el `setInterval` del auto-refresh para no gastar CPU mientras el panel no se ve.

---

## 3. Auto-refresh

Mientras está abierto, un `setInterval` cada 1s:
1. Repinta el header (countdown del próximo ciclo).
2. Si el tab activo es **Recolección** o **Construcción**, repinta el body completo (los countdowns y progreso son dinámicos).
3. Si el tab activo es **Settings**, no repinta (es estático).

El re-render completo es aceptable acá porque el contenido es chico (decenas de elementos). Si en el futuro llegamos a 50+ ciudades con todas expandidas, conviene hacer diff manual o capear a 2-5s.

---

## 4. Tab persistente

```js
window.localStorage.setItem("jambotTabActivo", "recoleccion");
```

Se guarda al cambiar de tab y se restaura al abrir el panel. Sobrevive a reload de la pestaña. Si el valor guardado no es uno de los 3 válidos (`settings`, `recoleccion`, `construccion`), cae a `settings`.

---

## 5. Tabs

### Settings
- Toggle "Finalizar construcción gratis" (lee/escribe `chrome.storage.local.jambotConfig.finalizarHabilitado`; la feature `finalizarConstruccion` escucha `chrome.storage.onChanged` y reacciona automáticamente).
- Lista de ciudades con select 5/10 min. Al cambiar, persiste en `jambotConfig.porCiudad[codigoCiudad]`.
- Sección "Mantenimiento":
  - **Limpiar historial** → confirma → vacía `historialPorAldea` + `ciclos` y borra `jambotHistorial_${world_id}` del storage.
  - **Exportar JSON** → genera un `Blob` con `{world_id, exportadoEn, ciclos, porAldea}` y dispara descarga `jambot-historial-{world_id}-{YYYY-MM-DD}.json`.
  - **Reset cooldown server** → confirma → vacía `lastClaimAtPorAldea` y borra `jambotLastClaimAt_${world_id}`. Útil solo para debugging — el bot vuelve a sincronizar solo en el próximo ciclo via `aldea.loot`.

### Recolección
Cinco secciones:

1. **Ciclo en curso** (solo si hay uno corriendo). Naranja. Header con `🍎 Ciclo #N · X/Y ciudades · A/B aldeas`. Resumen por ciudad con progreso parcial.
2. **Último ciclo**. Verde si fue completo (todas las ciudades a 6/6), rojo si quedó incompleto. Resumen con icono ✓/✗ por ciudad y totales.
3. **Ciclos anteriores** (colapsable, cerrado por default). Lista los ciclos persistidos excepto el último. Cada uno es una tarjeta colapsable con el mismo formato.
4. **Aldeas e historial**. Lista de ciudades. Cada ciudad expande sus 6 aldeas. Cada aldea expande su historial de 36 últimas recolecciones — timestamp, recursos, status, número de ciclo. Las ciudades con tanda incompleta en el último ciclo se abren expandidas por default.
5. **Errores y warnings recientes** (colapsable, cerrado por default). Lee del buffer global filtrado a las últimas 15 entradas. Botón "Limpiar buffer" llama `core.clearErrores()`.

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

## 7. Indicador en tiempo real (fuera del panel)

Bajo los botones del bot (`#jambot-buttons`), un `<div>` extra:

```
🍎 2/3 ciudades · 9/18 aldeas
```

Se muestra solo cuando `cicloActual != null`. Se actualiza llamando `actualizarIndicadorVivo()`:
- Al inicio de cada ciclo (poblar el indicador).
- Después de cada claim exitoso (incrementar contadores).
- Al final del ciclo (ocultar).

No depende del panel — sirve como "vista mínima" mientras el panel está cerrado. La idea es que con el panel cerrado vos seguís viendo el progreso del bot sin volver a abrir nada.

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
