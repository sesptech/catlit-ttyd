// catlit-ttyd — a Lit web component that speaks ttyd's WebSocket wire
// protocol and renders an interactive terminal via xterm.js. Drop the
// custom element into any Lit-based UI; point it at a ttyd backend and
// it handles the rest.
//
// This file is the entire public surface of the package. It exports:
//
//   - `CatlitTtyd`            — the Lit component class. Subclass to
//                               customize styles or behavior.
//   - `defineCatlitTtyd()`    — convenience registrar with a default
//                               tag name (`<catlit-ttyd>`). Call once
//                               from your app bootstrap.
//   - Type aliases for events emitted by the component.
//
// Why ttyd specifically?
//
//   ttyd (https://github.com/tsl0922/ttyd) is the de facto standard for
//   "give me a process behind a WebSocket I can hit from a browser."
//   Its wire protocol is small (~5 commands), well-documented, and used
//   in production by VS Code dev container terminals, Jupyter Server's
//   terminal sidecar (via tornado's ttyd-compatible mode), and a number
//   of self-hosted dashboards. By implementing the protocol directly in
//   the browser (instead of loading ttyd's own bundled HTML page in an
//   iframe), we get a first-class custom element with full control over
//   styling, focus, resize handling, and integration with the rest of
//   the host UI.
//
// Wire protocol (from tsl0922/ttyd, ported here):
//
//   Subprotocol: ["tty"]
//
//   On socket open the CLIENT sends:
//
//     JSON.stringify({ AuthToken: <token>, columns, rows })
//
//   Messages are binary frames with a 1-byte ASCII command prefix:
//
//     SERVER → CLIENT
//       '0' OUTPUT             — raw terminal bytes
//       '1' SET_WINDOW_TITLE   — UTF-8 title string
//       '2' SET_PREFERENCES    — JSON of xterm + ttyd client options
//
//     CLIENT → SERVER
//       '0' INPUT              — raw terminal bytes
//       '1' RESIZE_TERMINAL    — JSON { columns, rows }
//       '2' PAUSE              — flow control: ask server to stop
//       '3' RESUME             — flow control: ask server to resume
//
// The `tokenUrl` is fetched once before each connect. ttyd's default is
// "no token required" and just returns `{ token: "" }`; tighter deploys
// may return an authenticated short-lived token tied to the user's
// session.

import { LitElement, css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebLinksAddon } from "@xterm/addon-web-links";
import xtermCss from "@xterm/xterm/css/xterm.css?inline";

// ── Wire protocol constants ─────────────────────────────────────────

const enum ServerCmd {
  OUTPUT = 0x30, // '0'
  SET_WINDOW_TITLE = 0x31, // '1'
  SET_PREFERENCES = 0x32, // '2'
}

const enum ClientCmd {
  INPUT = "0",
  RESIZE_TERMINAL = "1",
  PAUSE = "2",
  RESUME = "3",
}

// Flow control thresholds (mirror ttyd defaults). When the volume of
// bytes written to xterm but not yet rendered exceeds `FLOW_LIMIT`, we
// queue a callback to track when xterm finishes processing; once the
// queue depth crosses `FLOW_HIGH` we PAUSE the server and resume below
// `FLOW_LOW`. This keeps the in-browser write buffer bounded under a
// firehose (e.g. a runaway `yes` loop) without ever dropping bytes.
const FLOW_HIGH = 5;
const FLOW_LOW = 2;
const FLOW_LIMIT = 100000;

// ── Public types ────────────────────────────────────────────────────

/** Connection lifecycle state surfaced via the `state` property and
 * the `catlit-ttyd-state` CustomEvent. */
export type CatlitTtydState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

/** Detail payload for the `catlit-ttyd-state` event. */
export interface CatlitTtydStateDetail {
  state: CatlitTtydState;
  /** Human-readable status message (e.g. "Connecting…", "Reconnecting"). */
  message: string;
  /** WebSocket close code when state is "closed"; undefined otherwise. */
  closeCode?: number;
}

/** Detail payload for the `catlit-ttyd-title` event. ttyd sends this
 * when the underlying shell or program updates its window title (e.g.
 * `\x1b]0;new-title\x07`). */
export interface CatlitTtydTitleDetail {
  title: string;
}

// Token endpoint response shape. ttyd returns `{ token: "" }` by
// default; deployments with auth return `{ token: "<bearer>" }`.
interface TokenResponse {
  token?: string;
}

// ── Component ──────────────────────────────────────────────────────

/**
 * <catlit-ttyd> — terminal element backed by ttyd.
 *
 * Minimal usage:
 *
 * ```html
 * <catlit-ttyd
 *   ws-url="wss://example.org/terminal/ws"
 *   token-url="/terminal/token"
 * ></catlit-ttyd>
 * ```
 *
 * The element sizes to fill its parent (`display: block; width:
 * 100%; height: 100%`). Wrap it in a sized container.
 *
 * Events:
 *
 *   - `catlit-ttyd-state`  ({@link CatlitTtydStateDetail}) — fired on
 *      every connection state transition.
 *   - `catlit-ttyd-title`  ({@link CatlitTtydTitleDetail}) — fired when
 *      the remote process updates its window title.
 *
 * Properties of note:
 *
 *   - `wsUrl` / `tokenUrl` — absolute or same-origin URLs of the ttyd
 *      WebSocket and token endpoints. Defaults assume ttyd is mounted
 *      at `/ws` and `/token` on the same origin.
 *   - `reconnect` — whether to auto-reconnect on unexpected close.
 *      Default `true`. Set to `false` to surface terminal exits to the
 *      user instead of silently reconnecting.
 *   - `theme` — xterm.js `ITheme` object. Falls back to a sensible dark
 *      default.
 *   - `fontFamily` / `fontSize` — terminal typography. The CSS variable
 *      `--catlit-ttyd-font-family` and `--catlit-ttyd-font-size` can be
 *      set instead if you'd rather drive it from your design system.
 */
export class CatlitTtyd extends LitElement {
  /** Same-origin or absolute URL of the ttyd WebSocket endpoint. */
  @property({ type: String, attribute: "ws-url" })
  wsUrl = "/ws";

  /** Same-origin or absolute URL of the ttyd token endpoint. */
  @property({ type: String, attribute: "token-url" })
  tokenUrl = "/token";

  /** Auto-reconnect on unexpected close (non-1000 codes). */
  @property({ type: Boolean })
  reconnect = true;

  /** Backoff between reconnect attempts, in milliseconds. */
  @property({ type: Number, attribute: "reconnect-delay-ms" })
  reconnectDelayMs = 1000;

  /** xterm.js theme override. */
  @property({ type: Object })
  theme: ITheme | undefined = undefined;

  /** Terminal font family. CSS variable `--catlit-ttyd-font-family`
   * takes precedence when set. */
  @property({ type: String, attribute: "font-family" })
  fontFamily =
    '"Cascadia Code", "Fira Code", Menlo, Monaco, Consolas, monospace';

  /** Terminal font size in pixels. CSS variable
   * `--catlit-ttyd-font-size` takes precedence when set. */
  @property({ type: Number, attribute: "font-size" })
  fontSize = 14;

  /** Number of lines kept in the scrollback buffer. */
  @property({ type: Number })
  scrollback = 5000;

  /** Whether the cursor blinks. */
  @property({ type: Boolean, attribute: "cursor-blink" })
  cursorBlink = true;

  /** When true, server-pushed xterm preferences (the SET_PREFERENCES
   * frame) overwrite the component's options. When false (default),
   * the component's settings are authoritative — useful when embedding
   * in a UI that owns its own theming. */
  @property({ type: Boolean, attribute: "accept-server-preferences" })
  acceptServerPreferences = false;

  /** Current connection state. Mirrors the `catlit-ttyd-state` event. */
  @state()
  state: CatlitTtydState = "idle";

  // ── Internal state ────────────────────────────────────────────────

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private canvasAddon: CanvasAddon | null = null;
  private webLinksAddon: WebLinksAddon | null = null;

  private socket: WebSocket | null = null;
  private token = "";
  private writtenBytes = 0;
  private pendingWrites = 0;

  private reconnectTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private terminalDisposers: Array<() => void> = [];
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();

  // Set true on disconnectedCallback to suppress lingering reconnect
  // timers from firing after the element is gone.
  private teardownInProgress = false;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
      background: var(--catlit-ttyd-background, #000);
      color: var(--catlit-ttyd-foreground, #e8e0f5);
    }
    .term-host {
      position: absolute;
      inset: 0;
      padding: var(--catlit-ttyd-padding, 0);
      box-sizing: border-box;
      overflow: hidden;
    }
  `;

  override render() {
    return html`
      <div class="term-host" part="terminal-host"></div>
      <style>${xtermCss}</style>
    `;
  }

  override firstUpdated(_changed: PropertyValues): void {
    const host = this.renderRoot.querySelector(
      ".term-host",
    ) as HTMLElement | null;
    if (!host) return;

    const termOptions: ITerminalOptions = {
      cursorBlink: this.cursorBlink,
      fontFamily: this.cssVarOr("--catlit-ttyd-font-family", this.fontFamily),
      fontSize: this.cssVarNumberOr("--catlit-ttyd-font-size", this.fontSize),
      scrollback: this.scrollback,
      theme: this.theme ?? {
        background: "#000000",
        foreground: "#e8e0f5",
        cursor: "#9f7ae9",
      },
      allowProposedApi: true,
    };

    this.terminal = new Terminal(termOptions);
    this.fitAddon = new FitAddon();
    this.canvasAddon = new CanvasAddon();
    this.webLinksAddon = new WebLinksAddon();

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.webLinksAddon);
    this.terminal.open(host);

    // CanvasAddon must be loaded after open() — it inspects the
    // current renderer pipeline. Fall back to the DOM renderer
    // silently if canvas isn't available (e.g. headless test envs).
    try {
      this.terminal.loadAddon(this.canvasAddon);
    } catch {
      // ignore: DOM renderer is the fallback
    }

    try {
      this.fitAddon.fit();
    } catch {
      // host element may have zero size momentarily; the
      // ResizeObserver below will refit once layout settles.
    }

    // Wire terminal → server.
    const dataDisp = this.terminal.onData((data) => this.sendInput(data));
    const resizeDisp = this.terminal.onResize(({ cols, rows }) =>
      this.sendResize(cols, rows),
    );
    this.terminalDisposers.push(
      () => dataDisp.dispose(),
      () => resizeDisp.dispose(),
    );

    // Refit on container resize (sidebar collapse, viewport changes,
    // mobile keyboard appearing, etc).
    this.resizeObserver = new ResizeObserver(() => {
      try {
        this.fitAddon?.fit();
      } catch {
        // transient zero-size: ignore
      }
    });
    this.resizeObserver.observe(host);

    // Take focus immediately so the user can type without clicking.
    this.terminal.focus();

    // Kick off the connection.
    void this.refreshTokenAndConnect();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardownInProgress = true;

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    for (const dispose of this.terminalDisposers) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    this.terminalDisposers = [];

    try {
      this.socket?.close(1000, "component disconnected");
    } catch {
      // ignore
    }
    this.socket = null;

    try {
      this.terminal?.dispose();
    } catch {
      // ignore
    }
    this.terminal = null;
    this.fitAddon = null;
    this.canvasAddon = null;
    this.webLinksAddon = null;
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Write raw bytes to the terminal display without sending them over
   * the WebSocket. Useful for splash messages, host-driven UX hints. */
  public writeLocal(data: string | Uint8Array): void {
    this.terminal?.write(data);
  }

  /** Force a refit on the terminal. Call this after a layout change
   * that the ResizeObserver wouldn't notice (e.g. CSS variable swap). */
  public fit(): void {
    try {
      this.fitAddon?.fit();
    } catch {
      // ignore
    }
  }

  /** Force a disconnect and (optionally) reconnect. */
  public reconnectNow(): void {
    try {
      this.socket?.close(1000, "manual reconnect");
    } catch {
      // ignore
    }
    void this.refreshTokenAndConnect();
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  private async refreshTokenAndConnect(): Promise<void> {
    this.transitionState("connecting", "Connecting…");
    try {
      const resp = await fetch(this.tokenUrl, { credentials: "include" });
      if (resp.ok) {
        const body = (await resp.json()) as TokenResponse;
        this.token = body.token ?? "";
      } else {
        // Token endpoint failed — proceed with empty token. ttyd's
        // default is no-auth and accepts this. Tighter deploys will
        // reject the auth frame and we'll surface the close.
        this.token = "";
      }
    } catch {
      this.token = "";
    }
    this.connect();
  }

  private connect(): void {
    if (this.teardownInProgress) return;
    if (!this.terminal) return;

    let sock: WebSocket;
    try {
      sock = new WebSocket(this.resolveWsUrl(), ["tty"]);
    } catch (err) {
      this.transitionState(
        "error",
        `Connection failed: ${(err as Error).message}`,
      );
      this.scheduleReconnect();
      return;
    }
    sock.binaryType = "arraybuffer";
    this.socket = sock;

    sock.addEventListener("open", () => this.onSocketOpen());
    sock.addEventListener("message", (ev) => this.onSocketMessage(ev));
    sock.addEventListener("close", (ev) => this.onSocketClose(ev));
    sock.addEventListener("error", () => {
      // The close event will fire next and drive the reconnect
      // decision; just surface the error state here.
      this.transitionState("error", "Connection error");
    });
  }

  private onSocketOpen(): void {
    if (!this.terminal || !this.socket) return;
    this.transitionState("open", "Connected");
    const authMsg = JSON.stringify({
      AuthToken: this.token,
      columns: this.terminal.cols,
      rows: this.terminal.rows,
    });
    this.socket.send(this.textEncoder.encode(authMsg));
    this.writtenBytes = 0;
    this.pendingWrites = 0;
  }

  private onSocketClose(ev: CloseEvent): void {
    if (ev.code === 1000) {
      this.transitionState("closed", "Disconnected", ev.code);
      return;
    }
    this.transitionState(
      "closed",
      `Disconnected (code ${ev.code})${this.reconnect ? " — reconnecting…" : ""}`,
      ev.code,
    );
    if (this.reconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.reconnect) return;
    if (this.teardownInProgress) return;
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.refreshTokenAndConnect();
    }, this.reconnectDelayMs);
  }

  // ── Server → client ───────────────────────────────────────────────

  private onSocketMessage(ev: MessageEvent): void {
    if (!this.terminal) return;
    const raw = ev.data as ArrayBuffer;
    if (!(raw instanceof ArrayBuffer) || raw.byteLength === 0) return;

    const cmd = new Uint8Array(raw, 0, 1)[0];
    const payload = raw.slice(1);

    switch (cmd) {
      case ServerCmd.OUTPUT:
        this.writeOutput(new Uint8Array(payload));
        break;
      case ServerCmd.SET_WINDOW_TITLE: {
        let title = "";
        try {
          title = this.textDecoder.decode(payload);
        } catch {
          return;
        }
        this.dispatchEvent(
          new CustomEvent<CatlitTtydTitleDetail>("catlit-ttyd-title", {
            detail: { title },
            bubbles: true,
            composed: true,
          }),
        );
        break;
      }
      case ServerCmd.SET_PREFERENCES:
        if (!this.acceptServerPreferences) break;
        this.applyServerPreferences(payload);
        break;
      default:
        // Unknown command from server — log once at debug level, drop.
        console.debug(`[catlit-ttyd] unknown server command: 0x${cmd.toString(16)}`);
        break;
    }
  }

  private writeOutput(data: Uint8Array): void {
    if (!this.terminal || !this.socket) return;
    this.writtenBytes += data.length;
    if (this.writtenBytes > FLOW_LIMIT) {
      this.terminal.write(data, () => {
        this.pendingWrites = Math.max(this.pendingWrites - 1, 0);
        if (this.pendingWrites < FLOW_LOW) {
          this.sendCmd(ClientCmd.RESUME);
        }
      });
      this.pendingWrites++;
      this.writtenBytes = 0;
      if (this.pendingWrites > FLOW_HIGH) {
        this.sendCmd(ClientCmd.PAUSE);
      }
    } else {
      this.terminal.write(data);
    }
  }

  private applyServerPreferences(payload: ArrayBuffer): void {
    if (!this.terminal) return;
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(this.textDecoder.decode(payload)) as Record<
        string,
        unknown
      >;
    } catch {
      return;
    }
    // Best-effort merge into xterm options. ttyd's SET_PREFERENCES
    // includes both xterm options and ttyd-specific knobs; we apply
    // only the ones that map onto xterm's option surface.
    for (const [k, v] of Object.entries(prefs)) {
      try {
        // @ts-expect-error — xterm's options type is keyed by string
        this.terminal.options[k] = v;
      } catch {
        // ignore unknown / non-writable option keys
      }
    }
    try {
      this.fitAddon?.fit();
    } catch {
      // ignore
    }
  }

  // ── Client → server ───────────────────────────────────────────────

  private sendInput(data: string): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    // 1 byte command prefix + up to 4 bytes UTF-8 per code point.
    const buf = new Uint8Array(data.length * 4 + 1);
    buf[0] = ClientCmd.INPUT.charCodeAt(0);
    const stats = this.textEncoder.encodeInto(data, buf.subarray(1));
    sock.send(buf.subarray(0, (stats.written as number) + 1));
  }

  private sendResize(cols: number, rows: number): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    const msg =
      ClientCmd.RESIZE_TERMINAL + JSON.stringify({ columns: cols, rows });
    sock.send(this.textEncoder.encode(msg));
  }

  private sendCmd(cmd: ClientCmd): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(this.textEncoder.encode(cmd));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /** Resolve a `wsUrl` that may be relative (e.g. "/ws") to an
   * absolute ws://or wss:// URL. Absolute URLs are returned as-is. */
  private resolveWsUrl(): string {
    const raw = this.wsUrl;
    if (/^wss?:\/\//.test(raw)) return raw;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (raw.startsWith("/")) {
      return `${scheme}//${window.location.host}${raw}`;
    }
    // Relative path without leading slash — resolve against current
    // document URL, replacing the protocol.
    const base = new URL(raw, window.location.href);
    return `${scheme}//${base.host}${base.pathname}${base.search}`;
  }

  /** Read a CSS custom property from computed style, falling back to a
   * default if unset. */
  private cssVarOr(name: string, fallback: string): string {
    const v = getComputedStyle(this).getPropertyValue(name).trim();
    return v.length > 0 ? v : fallback;
  }

  /** CSS-variable-aware number lookup. Trailing `px` and whitespace
   * are stripped; non-numeric values fall back. */
  private cssVarNumberOr(name: string, fallback: number): number {
    const v = getComputedStyle(this)
      .getPropertyValue(name)
      .trim()
      .replace(/px$/, "");
    if (v.length === 0) return fallback;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private transitionState(
    state: CatlitTtydState,
    message: string,
    closeCode?: number,
  ): void {
    this.state = state;
    this.dispatchEvent(
      new CustomEvent<CatlitTtydStateDetail>("catlit-ttyd-state", {
        detail: { state, message, closeCode },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

/** Register `<catlit-ttyd>` with the global customElements registry.
 *
 * Call this once in your app bootstrap. The default tag name matches
 * the package name; pass a custom tag name to avoid collisions when
 * embedding in a host app that may want to ship its own variant.
 *
 * ```ts
 * import { defineCatlitTtyd } from "catlit-ttyd";
 * defineCatlitTtyd();              // <catlit-ttyd>
 * defineCatlitTtyd("my-terminal"); // <my-terminal>
 * ```
 */
export function defineCatlitTtyd(tagName = "catlit-ttyd"): void {
  if (customElements.get(tagName)) return;
  customElements.define(tagName, class extends CatlitTtyd {});
}

// Re-export xterm types that show up in this module's public surface
// so consumers can construct themes etc. without separately depending
// on xterm.
export type { ITheme as CatlitTtydTheme } from "@xterm/xterm";
