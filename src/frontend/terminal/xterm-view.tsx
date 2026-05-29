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
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

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
    fitAddon.fit();
    terminal.focus();

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
    const dataDisposable = terminal.onData((data) => {
      client.sendInput(data);
    });
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      client.resize(terminal.cols, terminal.rows);
    });
    resizeObserver.observe(containerRef.current);
    client.resize(terminal.cols, terminal.rows);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      client.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal || !fitAddon) {
        return;
      }

      fitAddon.fit();
      terminal.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  return <div className="terminal-frame" ref={containerRef} onMouseDown={() => terminalRef.current?.focus()} />;
}

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
