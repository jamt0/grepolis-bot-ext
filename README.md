# Grepolis JamBot

Extensión de Chrome / navegadores Chromium (Edge, Brave, Vivaldi, Opera) que automatiza dos tareas repetitivas de Grepolis:

- **Recolección de recursos** en las aldeas farmeables de cada ciudad (botón "Recoger" — la opción rápida de 5/10 min).
- **Finalización gratis de construcciones** que entran en la ventana de menos de 5 min restantes (el botón "Gratis" del juego).

Funciona como **extensión local cargada en modo desarrollador**. No se publica en la Chrome Web Store y no se conecta a ningún servidor externo: todo el estado vive en `chrome.storage.local`.

---

## Tabla de contenidos

1. [Qué hace en detalle](#1-qué-hace-en-detalle)
2. [Requisitos](#2-requisitos)
3. [Instalación paso a paso](#3-instalación-paso-a-paso)
4. [Cómo usarlo](#4-cómo-usarlo)
5. [Configuración por ciudad (importante)](#5-configuración-por-ciudad-importante)
6. [El panel de información](#6-el-panel-de-información)
7. [Solución de problemas frecuentes](#7-solución-de-problemas-frecuentes)
8. [Privacidad y datos](#8-privacidad-y-datos)
9. [Documentación técnica](#9-documentación-técnica)

---

## 1. Qué hace en detalle

### Recolección
- Cada **5 o 10 minutos** (configurable por ciudad) recorre todas tus ciudades y, en cada una, intenta saquear sus 6 aldeas farmeables.
- Usa siempre el primer botón ("Recoger" 5min / 10min con la habilidad *Lealtad de los aldeanos*) — el más rentable por hora.
- Si una aldea aún tiene cooldown del servidor (porque la claimeaste manualmente o desde otra pestaña), la **salta sin atacar al server**.
- Si el server rechaza un claim por borde de cooldown, **reintenta hasta 3 veces** al final del ciclo (espera 5s entre rondas).
- Sobrevive a recargas de la pestaña: recuerda cuándo claimeó cada aldea y respeta los cooldowns vivos.

### Finalización de construcciones gratis
- Cada vez que una construcción entra en la **ventana de menos de 5 minutos** restantes, dispara el botón "Gratis" automáticamente.
- Lee la cola de **todas** tus ciudades (no solo la activa).
- Reagenda según la próxima orden que entre en ventana — no hace polling innecesario.
- Se enciende/apaga desde el panel del bot.

### Anti-detección / CAPTCHA
- Espera **2-2.5 s entre claims** con jitter aleatorio (rompe el patrón de "request exactamente cada N ms").
- Mezcla el orden de las aldeas dentro de cada ciudad cada ciclo.
- Si Grepolis dispara el CAPTCHA anti-bot, el bot **detecta**, **avisa con sonido + flash del título de la pestaña**, y mientras está activo solo hace un *probe* cada 30s para detectar resolución. Una vez que vos resolvés el CAPTCHA en el juego, el bot reanuda sin que tengas que hacer nada.

---

## 2. Requisitos

- **Chrome, Edge, Brave, Vivaldi u Opera** (cualquier navegador Chromium con `chrome.storage` y `Manifest V3`).
- **No** funciona en Firefox sin adaptar `manifest.json` (las APIs son compatibles pero el manifest difiere).
- Una cuenta de Grepolis activa.

---

## 3. Instalación paso a paso

> Esta extensión **no está publicada en la Chrome Web Store**. Tenés que cargarla manualmente como "extensión sin empaquetar". Es un proceso de 2 minutos.

### 3.1. Descargar el código

Opciones:
- **Con git** (recomendado, así podés actualizar con `git pull`):
  ```bash
  git clone https://github.com/jamt0/grepolis-bot-ext.git
  cd grepolis-bot-ext
  ```
- **Sin git**: bajá el ZIP desde GitHub → "Code" → "Download ZIP" → descomprimilo en una carpeta que **no muevas** después (la extensión deja de funcionar si cambia la ruta).

### 3.2. Activar el modo desarrollador en el navegador

En el navegador, abrí la página de extensiones:
- **Chrome / Brave**: `chrome://extensions`
- **Edge**: `edge://extensions`
- **Vivaldi / Opera**: análogo (`vivaldi://extensions`, etc.)

En la esquina superior derecha activá el toggle **"Modo de desarrollador"** (en Edge se llama "Modo desarrollador").

### 3.3. Cargar la extensión

1. Click en **"Cargar descomprimida"** (en Chrome) / **"Cargar sin empaquetar"** (en Edge).
2. Seleccioná la **carpeta raíz del proyecto** (la que contiene `manifest.json`).
3. La extensión aparece en la lista como **"Grepolis JamBot"** con un ID propio (algo como `eediamimojgbnjfaalcnlonenfdcogop`).
4. Asegurate de que el toggle de la extensión esté **activado**.

### 3.4. Verificar que cargó bien

1. Abrí Grepolis en el navegador (`https://es144.grepolis.com/...` o tu mundo).
2. **Logueate y entrá a una ciudad** (no te quedes en la pantalla de selección de mundo).
3. Esperá ~3 segundos.
4. En la esquina inferior izquierda deberían aparecer **dos botones cuadrados**: el verde con `▶` (play del bot) y el blanco con `⚙` (configuración).

Si no aparecen:
- Abrí DevTools (`F12`) → tab **Console** y buscá errores con prefijo `[JamBot/...]`.
- El error más común: `"window.JamBot incompleto"`. Significa que el orden de carga del manifest es incorrecto — verificá que no hayas modificado `manifest.json`.

---

## 4. Cómo usarlo

### Arrancar y parar el bot

| Acción | Botón |
|--------|-------|
| Iniciar la recolección | Click en el ▶ (verde) — pasa a ⏸ (azul) |
| Pausar | Click en el ⏸ — vuelve a ▶ verde |
| Abrir/cerrar panel | Click en el ⚙ (blanco) |

**El bot arranca pausado** después de cada recarga de la pestaña — tenés que apretar play manualmente. Eso es a propósito: evita que se dispare claims sin querer si solo abriste Grepolis para mirar algo.

### Indicador en tiempo real

Mientras hay un ciclo en curso, debajo de los botones aparece:

```
🍎 2/3 ciudades · 9/18 aldeas
```

Se actualiza con cada aldea farmeada y desaparece cuando el ciclo termina. **Te muestra el progreso sin necesidad de abrir el panel.**

---

## 5. Configuración por ciudad (importante)

> **Esto es lo único que tenés que configurar manualmente — y es lo que más impacta el rendimiento.**

Cada ciudad tiene un cooldown propio del servidor para los claims rápidos:

- **5 minutos** si la ciudad **no investigó** la habilidad de academia *Lealtad de los aldeanos*.
- **10 minutos** si la ciudad **sí investigó** *Lealtad de los aldeanos* (rinde +115% recursos pero duplica el cooldown).

**Por defecto el bot asume 5 minutos para todas las ciudades.** Si tenés ciudades con la habilidad Lealtad investigada, tenés que cambiarlas a 10 min en el panel para que el bot no le pegue al server antes de tiempo (lo que generaría rechazos `success:false` y perdería claims).

### Cómo configurar

1. Click en el botón ⚙ → tab **"Settings"**.
2. En la sección **"Tiempo de recolección por ciudad"** ves cada ciudad con un selector `5 min` / `10 min`.
3. Para cada ciudad, elegí el valor que coincida con su cooldown real:
   - Si la ciudad tiene Lealtad → **10 min**
   - Si no → **5 min**
4. La configuración se guarda automáticamente y persiste entre recargas.

> **Tip**: si no estás seguro, miralo desde la pantalla del juego: en cada ciudad, abrí "Academia" → buscá "Lealtad de los aldeanos". Si está investigada, tu ciudad rinde 10 min con +115% de recursos.

### Otras opciones del tab Settings

- **"Finalizar construcción gratis"** — toggle para activar/desactivar la feature de construcción independientemente del bot principal.
- **Mantenimiento**:
  - *Limpiar historial*: borra el historial de claims persistido. Útil si querés empezar limpio.
  - *Exportar JSON*: descarga un archivo con todo el historial — sirve como backup.
  - *Reset cooldown server*: borra el registro local de cuándo claimeaste cada aldea. Solo útil para debugging — el bot vuelve a sincronizar solo desde el server al próximo ciclo.

---

## 6. El panel de información

El botón ⚙ abre un panel con 3 tabs:

### Tab "Settings"
Configuración (ver punto 5).

### Tab "Recolección"
- **Ciclo en curso** (mientras corre): qué ciudades ya se procesaron y cuáles faltan, en color naranja.
- **Último ciclo**: resumen del último ciclo terminado — verde si fue completo (6/6 en cada ciudad), rojo si alguna ciudad quedó incompleta.
- **Ciclos anteriores** (colapsable): los últimos 36 ciclos persistidos (~6 horas a 10 min/ciclo). Click en cada uno para ver el detalle.
- **Aldeas e historial**: lista de tus ciudades. Expandí una ciudad para ver sus 6 aldeas, expandí una aldea para ver sus últimas 36 recolecciones (timestamp, deltas de recursos, status).
- **Errores y warnings recientes**: últimos eventos del buffer compartido — útil para diagnosticar si algo no anda bien.

### Tab "Construcción"
- Estado de la feature + countdown del próximo tick.
- **Último ciclo** de finalización.
- **Cola actual**: todas las órdenes de construcción pendientes en cualquiera de tus ciudades, ordenadas por tiempo restante. Las que entraron en la ventana de free-finish quedan marcadas en naranja.
- **Últimas finalizadas**: las últimas 20 órdenes finalizadas con éxito.
- **Errores y warnings** filtrados a la feature de construcción.

### Cerrar el panel

- Click en la **✕** del header.
- O click en cualquier lugar **fuera del panel** (sobre el mapa, recursos, etc.).

---

## 7. Solución de problemas frecuentes

### "Los botones del bot no aparecen"
- Asegurate de estar en la página del juego (no en el foro, wiki, ni en la selección de mundos).
- Verificá en `chrome://extensions` que la extensión está activada.
- Recargá la pestaña. Si sigue sin aparecer, abrí DevTools (F12) y mirá errores `[JamBot/bootstrap]`.

### "El bot dice 'CAPTCHA detectado' pero yo no veo nada"
- Grepolis dispara el CAPTCHA en una notificación dentro del juego — buscala. Una vez resuelto, el bot reanuda solo en menos de 30s.

### "Una tanda salió en rojo (3/6 aldeas)"
- Pasa de vez en cuando por borde de cooldown server. El retry automático (3 intentos) debería recuperarla en el siguiente ciclo.
- Si sucede repetidamente, mirá el panel **Errores recientes** — ahí va a aparecer la causa exacta (ej: `success=false` con detalle del server).

### "Después de un reload el primer ciclo no farmea nada"
- Es el comportamiento esperado durante hasta ~10 min (el tiempo del cooldown más largo). El bot ya sabe que las aldeas están en cooldown y espera; el panel muestra `próxima en X minutos`. Si una aldea se libera antes del próximo ciclo normal, el bot **adelanta el tick** automáticamente.

### "Quiero pausar pero la pestaña tiene que seguir abierta"
- Sí — la extensión vive en la pestaña. Si cerrás la pestaña, el bot deja de funcionar. Si solo querés que pare por un rato, click en ⏸.

### "Los datos del panel desaparecen después de cerrar el navegador"
- No deberían: persisten en `chrome.storage.local`. Si pasa, verificá que no tenés activado "Borrar cookies al cerrar" para Grepolis.

---

## 8. Privacidad y datos

- **Todo se ejecuta localmente**. La extensión no envía datos a ningún servidor que no sea el propio Grepolis (las requests legítimas del juego: claims, finalizar construcción, etc.).
- El historial, configuración y buffer de errores viven en `chrome.storage.local`, **únicamente en tu navegador**.
- No hay tracking, telemetría, ni "phone home".

---

## 9. Documentación técnica

Para entender cómo funciona el código por dentro:

- [docs/arquitectura.md](docs/arquitectura.md) — overview de la arquitectura modular (core + features + bridge).
- [docs/recoleccion.md](docs/recoleccion.md) — la feature de recolección en profundidad: ciclo, cooldown, retry, persistencia.
- [docs/finalizar-construccion.md](docs/finalizar-construccion.md) — la feature de finalizar construcción gratis.
- [docs/panel.md](docs/panel.md) — la UI del panel (tabs, secciones, auto-refresh).
- [docs/persistencia.md](docs/persistencia.md) — qué se guarda dónde y por qué.
- [docs/logging.md](docs/logging.md) — sistema de logs unificado y buffer de errores.
