# Persistencia

Todo el estado se guarda en **`chrome.storage.local`**, excepto la preferencia visual del tab activo que va en `window.localStorage`. La cuota de `chrome.storage.local` es **10 MB** por extensión.

---

## 1. Resumen

| Clave | Scope | Tamaño típico | Persiste en | Sobrevive a |
|-------|-------|---------------|-------------|-------------|
| `jambotConfig` | Global | < 1 KB | `chrome.storage.local` | Reload, reinicio del navegador, reinstalar la extensión (¡no!) |
| `jambotErrores` | Global | < 100 KB | `chrome.storage.local` | Reload, reinicio del navegador |
| `jambotLastClaimAt_${world_id}` | Por mundo | ~9 KB con 50 ciudades | `chrome.storage.local` | Reload, reinicio del navegador |
| `jambotHistorial_${world_id}` | Por mundo | ~2.7 MB con 50 ciudades | `chrome.storage.local` | Reload, reinicio del navegador |
| `jambotConstruccion_${world_id}` | Por mundo | < 5 KB | `chrome.storage.local` | Reload, reinicio del navegador |
| `jambotTabActivo` | Global | < 50 B | `window.localStorage` | Reload, reinicio del navegador |

**Total estimado para 50 ciudades**: ~2.8 MB (28% de la cuota). Para 3 ciudades: ~50 KB.

---

## 2. Detalle por clave

### `jambotConfig`

Configuración del usuario. Global (no namespaceada por mundo) — la asunción es que un mundo Grepolis = una cuenta = mismas preferencias.

```js
{
  finalizarHabilitado: true
}
```

- `finalizarHabilitado` — toggle de la feature de finalizar construcción gratis.

> **Nota histórica**: hasta vNN existió `porCiudad` con el cooldown manual (5/10 min) por ciudad. Ahora se auto-detecta de `lootable_at - last_looted_at` del modelo `FarmTownPlayerRelation` que ya viene en la respuesta del server al boot, así que esa key se borra automáticamente en `recoleccion.init()` si está presente (legacy cleanup).

Lectura/escritura: directamente vía `chrome.storage.local.get/set` en los handlers del panel y en `finalizarConstruccion.js`.

### `jambotLastClaimAt_${world_id}`

Map de cuándo claimeamos por última vez cada aldea exitosamente.

```js
{
  7:   1777853392000,      // ms (Date.now())
  8:   1777853395000,
  9:   1777853398000,
  ...
}
```

Solo se setea cuando `recolectarAldea` retorna `status: "ok"`. Skip por cooldown / `descartar` / `reintentar` no actualizan.

Lectura: `cargarLastClaimAt()` al boot. Escritura: `guardarLastClaimAt()` después de cada claim exitoso (fire-and-forget).

**Por qué namespaceado por `world_id`**: si un mismo navegador tiene varias cuentas en mundos distintos (es144, es145, etc.), los IDs de aldea pueden colisionar y llevar a respetar cooldowns equivocados. Namespacear lo evita.

### `jambotHistorial_${world_id}`

El más grande. Guarda 2 cosas:

```js
{
  porAldea: {
    7: [
      {
        ts: 1777853392000,
        ciudadId: 91, ciudadNombre: "001 Jam",
        aldeaNombre: "Takona",
        ciclo: 42,
        status: "ok",
        dW: 151, dS: 150, dI: 150,
        totales: { wood: 6072, stone: 4991, iron: 6810 }
      },
      ... // hasta HISTORIAL_MAX = 36 entradas (FIFO)
    ],
    8: [...],
    ...
  },
  ciclos: [
    {
      n: 41,
      inicio: 1777853000000,
      fin: 1777853027000,
      duracion: 27000,
      captchaDurante: false,
      ciudades: {
        91:   { nombre: "001 Jam", claims: 6, esperado: 6, wood: 1024, stone: 982, iron: 895, aldeasFalladas: [] },
        1156: { ... },
        1339: { ... }
      },
      totalCiudades: 3,
      ciudadesCompletadas: 3,
      totalAldeas: 18,
      aldeasCompletadas: 18
    },
    ... // hasta CICLOS_MAX = 36 ciclos (FIFO)
  ]
}
```

**Retrocompatibilidad**: las versiones anteriores guardaban solo `ultimoCiclo`. `cargarHistorial()` detecta el formato viejo y lo promueve a `ciclos = [ultimoCiclo]` automáticamente.

**Status posibles** en cada entrada de `porAldea[id]`:
- `"ok"` — claim exitoso. Trae `dW/dS/dI` (deltas) y `totales`.
- `"reintentar"` — server respondió `success: false`. Trae `errorMsg`.
- `"descartar"` — sin `relation_id`, almacén lleno, o sin notification Town. Trae `errorMsg`.
- `"saltada-cooldown"` — cooldown vivo (ya sea por `lastClaimAtPorAldea` o por `aldea.loot` del server). Trae `esperaSeg`.

### `jambotConstruccion_${world_id}`

Estado persistido de la feature de finalizar construcción gratis.

```js
{
  ultimoCiclo: {
    inicio, fin, duracion,
    ordenesEnCola: 12,
    ordenesEnVentana: 2,
    finalizadas: 2,
    captchaDurante: false
  },
  finalizadas: [
    {
      ts: 1777853392000,
      town_id: 91, town_nombre: "001 Jam",
      id: 82674, building_type: "market",
      mensaje: "La construcción se ha completado correctamente."
    },
    ... // hasta FINALIZADAS_MAX = 20 (FIFO)
  ]
}
```

**No** persiste `ultimaCola` (la cola actual) ni `proximoTickAt` — esos se recalculan al primer tick post-reload, no vale la pena guardarlos.

### `jambotErrores`

Buffer global de warnings y errores capturados por `core.logWarn` / `core.logError`.

```js
[
  {
    ts: 1777853392000,
    iso: "2026-05-03T19:09:50.000Z",
    nivel: "warn" | "error",
    scope: "recoleccion" | "finalizar" | "core" | "global" | ...,
    mensaje: "string",
    extra: [...]    // opcional, objetos serializados
  },
  ... // hasta MAX_ERRORES = 200 (FIFO)
]
```

Global (no por mundo) — los errores son ruido transitorio y no vale la pena duplicar storage por mundo.

**Throttle de escritura**: `guardarError` agenda un `setTimeout(persistir, 500ms)` por cada llamada, cancelando el anterior. Bursts de muchos errores en pocos ms se colapsan en 1 sola escritura. Sin esto, una avalancha de warnings podría hacer 10+ escrituras/seg al storage (innecesario para datos de diagnóstico).

### `jambotTabActivo` (en `localStorage`, no `chrome.storage`)

Una string: `"settings"` | `"recoleccion"` | `"construccion"`. Default `"settings"` si está ausente o tiene valor inválido.

Va en `window.localStorage` y no en `chrome.storage` porque es una preferencia 100 % visual y queremos lectura sincrónica en cada `togglePanelConfig` (sin promesa). El costo es mínimo y no genera contención.

---

## 3. Ciclo de vida

### Al instalar la extensión por primera vez
- Todos los blobs vacíos / inexistentes.
- El bot arranca pausado.
- Al primer ciclo: lee `aldea.loot` del server para sincronizar cooldowns iniciales.

### Al recargar la pestaña
- `chrome.storage.local` se mantiene intacto.
- `core.init()` carga `jambotErrores`.
- `recoleccion.init()` carga `jambotConfig`, `jambotLastClaimAt_${world_id}`, `jambotHistorial_${world_id}`.
- `finalizarConstruccion.init()` carga `jambotConstruccion_${world_id}`.
- El bot arranca pausado (no se reinicia por sí solo — diseño deliberado).
- Al primer ciclo: respeta `lastClaimAtPorAldea` cargado + `aldea.loot` para aldeas que nunca claimeamos.

### Al cerrar y abrir el navegador
- Igual que reload, todo persiste.

### Al desinstalar la extensión
- Chrome borra automáticamente todo `chrome.storage.local` de la extensión.
- `localStorage` también se borra (vive en el storage de la pestaña, no de la extensión — pero está namespaceado al dominio, así que dura mientras Grepolis tenga datos).

### Al hacer "Borrar datos del sitio" en el navegador
- Si el usuario marca "cookies y datos del sitio" para Grepolis: se borra `localStorage.jambotTabActivo` (y también el `localStorage.game` que usa `saveToken.js`, lo que rompe la extensión hasta el próximo login).
- `chrome.storage.local` NO se borra con esa acción (es independiente del storage del sitio).

### Al hacer click en "Limpiar historial" del panel
- Borra `jambotHistorial_${world_id}` de `chrome.storage.local`.
- Resetea `historialPorAldea = {}`, `ciclos = []`, `cicloActual = null` en memoria.
- No toca otras claves.

### Al hacer click en "Reset cooldown server"
- Borra `jambotLastClaimAt_${world_id}` y resetea el map.
- El próximo ciclo va a probar todas las aldeas; las que estén en cooldown server las salta usando `aldea.loot`.

---

## 4. Inspección manual desde DevTools

```js
// Ver TODO lo que tiene la extensión
chrome.storage.local.get(null, (d) => console.log(d));

// Ver una sola clave
chrome.storage.local.get("jambotHistorial_es144", (d) => console.log(d));

// Tamaño usado (en bytes)
chrome.storage.local.getBytesInUse(null, (n) => console.log(`${n} B (${(n / 1024 / 1024).toFixed(2)} MB)`));

// Wipe total (cuidado — irreversible)
chrome.storage.local.clear();
```

También se puede hacer desde **DevTools → Application → Storage → Extension Storage** en Chrome.

---

## 5. Cuotas y límites

| Storage | Cuota | Por item |
|---------|-------|----------|
| `chrome.storage.local` | 10 MB | sin límite |
| `chrome.storage.sync` | 100 KB | 8 KB | (no lo usamos)
| `localStorage` | ~5-10 MB por origen | sin límite |

Nuestro uso para 50 ciudades es ~28 % de la cuota de `local`. Si en el futuro creciera, hay 3 opciones:

1. **Bajar `HISTORIAL_MAX` o `CICLOS_MAX`** (cambio de 1 línea).
2. **Sacar nombres redundantes** (`ciudadNombre`, `aldeaNombre` en cada entrada) y resolverlos en runtime → ahorra ~50 % del espacio.
3. **Agregar `"unlimitedStorage"` al `manifest.json`** → cuota ilimitada en local (Chrome lo permite sin restricciones).

Hoy ninguna de las 3 hace falta.

---

## 6. Ver también

- [arquitectura.md](arquitectura.md) — cómo se inicializa todo y qué carga qué.
- [recoleccion.md](recoleccion.md) — feature que más storage usa.
- [logging.md](logging.md) — `jambotErrores` en detalle.
