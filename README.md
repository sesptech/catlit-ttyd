# catlit-ttyd

A [Lit](https://lit.dev/) web component that speaks [ttyd](https://github.com/tsl0922/ttyd)'s WebSocket protocol — embed a real interactive terminal into any Lit-based UI.

## Why

ttyd is the de facto standard for "give me a process behind a WebSocket I can hit from a browser." Its bundled HTML client is a perfectly fine standalone app, but iframing it into a host UI gives up focus management, theming, resize coordination, and integration with the rest of your app.

`catlit-ttyd` reimplements ttyd's wire protocol as a Lit element backed by [xterm.js](https://xtermjs.org/). You get:

- A first-class custom element with shadow-DOM styling.
- Reactive properties for connection URLs, theme, font, reconnect policy.
- Custom events for connection state and window title updates.
- A clean `disconnectedCallback` that tears down sockets and timers.
- Automatic refit on container resize via `ResizeObserver`.
- ttyd-style flow control to keep the in-browser buffer bounded under a firehose.

It does **not** replace ttyd — you still run ttyd on the server. This package is the browser-side client.

## Install

```sh
npm install catlit-ttyd
```

`lit` is a peer dependency (^3.0.0). `@xterm/xterm` + the canvas, fit, and web-links addons are regular dependencies and are bundled at build time.

## Usage

```ts
import { defineCatlitTtyd } from "catlit-ttyd";

defineCatlitTtyd();
```

```html
<div style="width: 800px; height: 500px;">
  <catlit-ttyd
    ws-url="/terminal/ws"
    token-url="/terminal/token"
  ></catlit-ttyd>
</div>
```

The element sizes to fill its parent (`display: block; width: 100%; height: 100%`). Wrap it in a sized container.

### Server-side ttyd

Any [ttyd](https://github.com/tsl0922/ttyd) instance works. Minimal launch:

```sh
ttyd --port 7681 --writable bash
```

Front it with your reverse proxy of choice (Caddy / nginx / Traefik). Two endpoints are needed:

- `GET /token` — returns `{ "token": "..." }`. Empty string is fine for no-auth deployments.
- `WS /ws` — terminal I/O. The component connects with WebSocket subprotocol `["tty"]`.

Strip the prefix and proxy these two paths to ttyd's port. ttyd's own HTML bundle (served at `/`) is **not** needed.

#### Caddy example

```caddyfile
route /terminal/ws /terminal/token {
    uri strip_prefix /terminal
    reverse_proxy 127.0.0.1:7681
}
```

## API

### Properties

| Property | Attribute | Type | Default | Description |
|---|---|---|---|---|
| `wsUrl` | `ws-url` | string | `/ws` | WebSocket endpoint. Relative paths are resolved against the current origin with the matching `ws://` / `wss://` scheme. |
| `tokenUrl` | `token-url` | string | `/token` | Token endpoint. Fetched once before each connect. |
| `reconnect` | `reconnect` | boolean | `true` | Auto-reconnect on unexpected close (non-1000 codes). |
| `reconnectDelayMs` | `reconnect-delay-ms` | number | `1000` | Backoff between reconnect attempts. |
| `theme` | — | `ITheme` | dark default | xterm.js theme. |
| `fontFamily` | `font-family` | string | Cascadia/Fira/system mono | Terminal typography. |
| `fontSize` | `font-size` | number | `14` | Pixel size. |
| `scrollback` | `scrollback` | number | `5000` | Lines kept in the buffer. |
| `cursorBlink` | `cursor-blink` | boolean | `true` | Cursor blink. |
| `acceptServerPreferences` | `accept-server-preferences` | boolean | `false` | Apply ttyd's `SET_PREFERENCES` frames. Default off — the embedder typically owns theming. |

### CSS Custom Properties

| Property | Default | Description |
|---|---|---|
| `--catlit-ttyd-background` | `#000` | Host background; visible during connect / behind padding. |
| `--catlit-ttyd-foreground` | `#e8e0f5` | Fallback host text color (terminal cell colors come from xterm theme). |
| `--catlit-ttyd-padding` | `0` | Padding around the terminal canvas inside the host element. |
| `--catlit-ttyd-font-family` | — | When set, overrides the `fontFamily` property. |
| `--catlit-ttyd-font-size` | — | When set, overrides the `fontSize` property. |

### Events

| Event | Detail | When |
|---|---|---|
| `catlit-ttyd-state` | `{ state, message, closeCode? }` | Connection state transitions (`idle` → `connecting` → `open` → `closed` / `error`). |
| `catlit-ttyd-title` | `{ title }` | Remote process updates its window title (e.g. `printf '\e]0;new\a'`). |

### Methods

| Method | Description |
|---|---|
| `writeLocal(data)` | Write to the terminal display without sending over the wire (splash messages, hints). |
| `fit()` | Force a refit. Call after layout changes the `ResizeObserver` wouldn't notice (e.g. CSS variable swap). |
| `reconnectNow()` | Drop the current socket and immediately reconnect. |

### Custom tag name

`defineCatlitTtyd()` registers the default `<catlit-ttyd>` element. Pass a tag name to avoid collisions or to ship a themed variant:

```ts
defineCatlitTtyd("my-terminal");
```

Or subclass `CatlitTtyd` directly:

```ts
import { CatlitTtyd } from "catlit-ttyd";

class BrandedTerminal extends CatlitTtyd {
  override fontFamily = "Iosevka, monospace";
}
customElements.define("branded-terminal", BrandedTerminal);
```

## Wire protocol

`catlit-ttyd` implements ttyd's protocol verbatim. For reference:

```
Subprotocol: ["tty"]

On socket open the client sends:
  JSON.stringify({ AuthToken: <token>, columns, rows })

Binary frames with 1-byte ASCII command prefix:

  SERVER → CLIENT
    '0' OUTPUT            — raw terminal bytes
    '1' SET_WINDOW_TITLE  — UTF-8 title string
    '2' SET_PREFERENCES   — JSON of xterm + ttyd client options

  CLIENT → SERVER
    '0' INPUT             — raw terminal bytes
    '1' RESIZE_TERMINAL   — JSON { columns, rows }
    '2' PAUSE             — flow control
    '3' RESUME            — flow control
```

Source: [ttyd `html/src/components/terminal/xterm/index.ts`](https://github.com/tsl0922/ttyd/blob/main/html/src/components/terminal/xterm/index.ts).

## Development

```sh
npm install
npm run dev         # Vite dev server (demo page coming)
npm run build       # TypeScript typecheck + library build to dist/
npm test            # vitest run
```

## License

MIT. Portions of the wire-protocol implementation are derived from the [ttyd project](https://github.com/tsl0922/ttyd) by Shuanglei Tao, also MIT. See `LICENSE`.
