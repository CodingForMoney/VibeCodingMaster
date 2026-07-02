import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { TerminalClient } from "./terminal-client.js";

export interface XtermViewProps {
  sessionId: string;
  active?: boolean;
  onEvent?: (message: string) => void;
}

export function XtermView({ sessionId, active = true, onEvent }: XtermViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  const onEventRef = useRef(onEvent);

  function fitAndResize(options: { focus?: boolean } = {}): boolean {
    const container = containerRef.current;
    const client = clientRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !client || !fitAddon || !terminal) {
      return false;
    }

    const rect = container.getBoundingClientRect();
    if (rect.width < MIN_VISIBLE_TERMINAL_WIDTH || rect.height < MIN_VISIBLE_TERMINAL_HEIGHT) {
      return false;
    }

    fitAddon.fit();
    if (terminal.cols < MIN_TERMINAL_COLS || terminal.rows < MIN_TERMINAL_ROWS) {
      return false;
    }

    client.resize(terminal.cols, terminal.rows);
    if (options.focus) {
      terminal.focus();
    }
    return true;
  }

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      drawBoldTextInBrightColors: true,
      fontFamily: "Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      fontWeight: "400",
      fontWeightBold: "700",
      lineHeight: 1.35,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: CLAUDE_TERMINAL_THEME
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const initialRect = containerRef.current.getBoundingClientRect();
    if (initialRect.width >= MIN_VISIBLE_TERMINAL_WIDTH && initialRect.height >= MIN_VISIBLE_TERMINAL_HEIGHT) {
      fitAddon.fit();
    }

    const client = new TerminalClient(sessionId, {
      onOutput(data) {
        terminal.write(data);
      },
      onStatus(message) {
        onEventRef.current?.(message.type);
      },
      onError(message) {
        terminal.writeln(`\r\n[VCM] ${message}`);
        onEventRef.current?.(message);
      }
    });
    clientRef.current = client;
    if (terminal.cols >= MIN_TERMINAL_COLS && terminal.rows >= MIN_TERMINAL_ROWS) {
      client.resize(terminal.cols, terminal.rows);
    }
    const dataDisposable = terminal.onData((data) => {
      client.sendInput(data);
    });
    let resizeFrame = 0;
    let initialFrame = 0;
    let initialRetry = 0;
    const requestFitAndResize = () => {
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        fitAndResize({ focus: activeRef.current });
      });
    };
    const resizeObserver = new ResizeObserver(() => {
      requestFitAndResize();
    });
    resizeObserver.observe(containerRef.current);
    initialFrame = window.requestAnimationFrame(requestFitAndResize);
    initialRetry = window.setTimeout(requestFitAndResize, 120);

    return () => {
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (initialFrame) {
        window.cancelAnimationFrame(initialFrame);
      }
      if (initialRetry) {
        window.clearTimeout(initialRetry);
      }
      resizeObserver.disconnect();
      dataDisposable.dispose();
      client.close();
      terminal.dispose();
      clientRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const frames: number[] = [];
    const timers: number[] = [];
    frames.push(window.requestAnimationFrame(() => {
      fitAndResize({ focus: true });
      frames.push(window.requestAnimationFrame(() => fitAndResize({ focus: true })));
    }));
    timers.push(window.setTimeout(() => fitAndResize({ focus: true }), 160));
    timers.push(window.setTimeout(() => fitAndResize({ focus: true }), 360));

    return () => {
      for (const frame of frames) {
        window.cancelAnimationFrame(frame);
      }
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [active]);

  useEffect(() => {
    const onWindowResize = () => {
      if (activeRef.current) {
        fitAndResize();
      }
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  return <div className="terminal-frame" ref={containerRef} onMouseDown={() => terminalRef.current?.focus()} />;
}

const MIN_VISIBLE_TERMINAL_WIDTH = 160;
const MIN_VISIBLE_TERMINAL_HEIGHT = 80;
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;

const CLAUDE_TERMINAL_THEME = {
  background: "#0d1117",
  foreground: "#d6deeb",
  cursor: "#ffd866",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  black: "#1f2430",
  red: "#ff5c57",
  green: "#5af78e",
  yellow: "#f3f99d",
  blue: "#57c7ff",
  magenta: "#ff6ac1",
  cyan: "#9aedfe",
  white: "#f1f1f0",
  brightBlack: "#686868",
  brightRed: "#ff5c57",
  brightGreen: "#5af78e",
  brightYellow: "#f3f99d",
  brightBlue: "#57c7ff",
  brightMagenta: "#ff6ac1",
  brightCyan: "#9aedfe",
  brightWhite: "#ffffff"
};
