# Logging unificado

Sistema compartido de logs implementado en [`core.js`](../core.js). Todas las features lo usan vía `ctx.core.log/logWarn/logError/logCiclo`.

---

## 1. API

### `core.log(scope, mensaje, tipo?)`
- `scope` (string): identifica la feature (`"recoleccion"`, `"finalizar"`, `"core"`, `"bootstrap"`, `"panel"`).
- `mensaje` (string): el texto.
- `tipo` (opcional): `"info"` (azul, default) | `"ok"` (verde) | `"warn"` (ámbar) | `"error"` (fondo rojo) | `"cycle"` (violeta).

Imprime con `console.log`. **No** entra al buffer persistido.

### `core.logWarn(scope, mensaje, ...extra)`
- Mismo formato pero con prefijo `⚠` y color ámbar.
- Imprime con `console.warn`.
- **Sí** entra al buffer (`nivel: "warn"`).

### `core.logError(scope, mensaje, ...extra)`
- Mismo formato con prefijo `✖ ERROR:` y fondo rojo destacado.
- Imprime con `console.error`.
- **Sí** entra al buffer (`nivel: "error"`).

### `core.logCiclo(scope, titulo, tipo?)`
Banner con separadores `═` × 60. Default violeta (`"cycle"`); se puede pasar `"info"` para azul. Pensado para encabezados de ciclo y de ciudad.

---

## 2. Formato visual

Cada línea tiene 3 partes coloreadas con `%c` de la consola de Chrome:

```
[2026-05-03 19:11:11] [recoleccion] ▸ 001 Jam ← Hytaaeky: +151/+150/+150 ...
└────────┬────────┘ └─────┬─────┘ └─────────────┬──────────────────────┘
   gris (timestamp)   gris (scope)    color por nivel (info/ok/warn/error)
```

Banners (logCiclo) van en una sola "línea" con 3 sublíneas:

```
════════════════════════════════════════════════════════════
[2026-05-03 19:11:11] [recoleccion] CICLO #42
════════════════════════════════════════════════════════════
```

---

## 3. Convenciones de uso

| Tipo | Cuándo usar | Ejemplo |
|------|-------------|---------|
| `log(scope, msg)` | Eventos rutinarios, info de progreso | `"obteniendo info..."` |
| `log(scope, msg, "ok")` | Algo completado bien | `"ciclo OK · duró 27s"` |
| `logWarn(scope, msg, ...extra)` | Algo no fatal pero merece atención | `"server respondió success=false"` |
| `logError(scope, msg, ...extra)` | Falla — siempre va al buffer | `"falló aldea id=12 — TypeError: ..."` |
| `logCiclo(scope, titulo)` | Banner de ciclo nuevo (violeta) | `"CICLO #42"` |
| `logCiclo(scope, titulo, "info")` | Banner de subsección (azul) | `"001 Jam"` |

**Regla**: warnings + errores van al buffer persistido. `log` normal NO. La idea es que el buffer sea para post-mortem ("qué falló") y los logs normales para tail-en-vivo de DevTools.

---

## 4. Buffer de errores

```js
const erroresBuffer = [];
const MAX_ERRORES = 200;       // FIFO
```

Cada entrada:

```js
{
  ts:      1777853392000,                         // ms (Date.now())
  iso:     "2026-05-03T19:09:50.000Z",
  nivel:   "warn" | "error",
  scope:   "recoleccion" | "finalizar" | ...,
  mensaje: "string",
  extra:   [...]                                   // serializado, opcional
}
```

### Serialización de `extra`
- `Error` instances → `{name, message, stack}`.
- Objetos planos → `JSON.parse(JSON.stringify(e))` (round-trip, descarta funciones y referencias circulares).
- Resto → `String(e)`.

Esto evita guardar referencias mutables que podrían cambiar después y mostrar valores "viajados en el tiempo".

### Persistencia
- Clave: `jambotErrores` en `chrome.storage.local`. Global, no namespaceado por mundo.
- Throttle de 500 ms: cada `guardarError` agenda un `setTimeout` de 500 ms cancelando el anterior. Burst de N errores en pocos ms = 1 sola escritura al storage.
- Tamaño típico: 200 errores × ~500 B (con stack traces) ≈ 100 KB. Despreciable vs cuota.

---

## 5. API de inspección desde DevTools

Expuesta en `window.JamBot.errores` para que el usuario pueda llamarla rápido en la consola del juego:

```js
JamBot.errores()                                    // imprime todo el buffer
JamBot.errores({ scope: "recoleccion" })            // filtra por feature
JamBot.errores({ nivel: "error" })                  // solo errores fatales
JamBot.errores({ nivel: "warn" })                   // solo warnings
JamBot.errores({ desde: Date.now() - 600_000 })     // últimos 10 min
JamBot.errores({ scope: "finalizar", nivel: "error" })  // combinado

JamBot.errores.lista()                              // array crudo (para inspección programática)
JamBot.errores.limpiar()                            // vacía buffer + storage
```

`imprimirErrores()` agrupa con `console.group` y usa el mismo formato de color que los logs en vivo. Si una entrada tiene `extra`, lo expande como segundo argumento de `console.warn/error` (DevTools muestra el objeto interactivo).

---

## 6. Captura global de errores

Instalada en `core.init()`:

```js
window.addEventListener("error", (e) => {
  if (!e.filename.startsWith(extPrefix)) return;   // filtra solo nuestros
  logError("global", e.message, e.error);
});

window.addEventListener("unhandledrejection", (e) => {
  logError("global", `unhandledrejection: ${reason}`, reason);
});
```

### Filtro por origen
`extPrefix` = `chrome.runtime.getURL("")` → algo como `"chrome-extension://eediamimojgbnjfaalcnlonenfdcogop/"`. Solo registramos errores cuyo `e.filename` empieza con ese prefijo. Eso filtra el ruido enorme de:
- `game.min.js` (errores propios del juego)
- `jquery-3.6.0.js`, `jquery-migrate.js`
- Embeds de YouTube en el lobby (CSP violations)
- `notification.js` con bugs como el `name_plural` que aparece al abrir mensajes del foro

Sin el filtro, el buffer se llenaría de basura ajena en minutos.

### unhandledrejection
Estos NO traen `filename`. Los registramos todos sin filtrar — son raros y siempre vale la pena verlos. En la práctica, casi todos vienen de promesas nuestras que rompieron sin catch.

---

## 7. Otros usos del log en `core.js`

- `setPaused(true|false)` → `core.log("core", "PAUSADO" | "REANUDADO")`. Además dispara un `console.trace` para que en DevTools puedas ver de dónde vino el cambio (útil cuando "el bot se pausa solo" — el stack te dice si fue un click humano o algo programático).
- `onCaptchaDetectado()` → `logWarn("core", "CAPTCHA detectado — el ciclo seguirá con probes cada 30s")`.
- `onCaptchaResuelto()` → `log("core", "CAPTCHA resuelto — operación normal", "ok")`.

---

## 8. Patrones recomendados

### En features
```js
async function init(ctx) {
  const { core } = ctx;
  core.log("miFeature", "iniciando…");
  try {
    await algo();
    core.log("miFeature", "carga OK", "ok");
  } catch (e) {
    core.logError("miFeature", "no pude cargar X", e);
  }
}
```

### Nunca usar `console.log/warn/error` directo en código de feature
Romperías la unificación: el log no tendría timestamp, no entraría al buffer, no aplicaría colores. Excepción: `contentScript.js` antes de que `core.init()` complete — ahí no podés usar `core.log` porque todavía no existe.

---

## 9. Ver también

- [arquitectura.md](arquitectura.md) — dónde se instala la captura global y cómo se inicializa.
- [persistencia.md](persistencia.md) — `jambotErrores` en detalle de storage.
- [panel.md](panel.md) — la UI que muestra el buffer al usuario.
