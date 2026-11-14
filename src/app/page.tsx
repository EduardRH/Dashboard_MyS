"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Usb,
  Unplug,
  Play,
  Square,
  Sliders,
  Activity,
  Terminal,
  RefreshCw,
  AlertTriangle,
  Car,
  Clock,
  Send,
  Zap,
  CheckCircle2,
  Radio,
} from "lucide-react";

// =========================================================================
// TIPOS DE DATOS (Estructura JSON del Arduino Mega 2560)
// =========================================================================
type ColorLuz = "ROJO" | "AMARILLO" | "VERDE";
type NivelTrafico = "VACIO" | "APROXIMACION" | "MODERADO" | "CONGESTION_ALTA";

interface DatosViaJSON {
  s1_parada_cm: number;
  s1_ocupado: boolean;
  s2_cola_cm: number;
  s2_ocupado: boolean;
  estado_trafico: NivelTrafico;
}

interface ConfigTiempos {
  T_VERDE_VACIO: number;
  T_VERDE_APROX: number;
  T_VERDE_MODERADO: number;
  T_VERDE_CONGESTION: number;
  T_VERDE_MAX_ABS: number;
  T_EXTENSION_ONDA: number;
  T_AMARILLO: number;
  T_DESPEJE_ANTICIP: number;
  UMBRAL_S1_CM: number;
  UMBRAL_S2_CM: number;
}

interface TelemetriaArduino {
  timestamp_ms: number;
  evento: string;
  semaforos: {
    via_A: { luz: ColorLuz };
    via_B: { luz: ColorLuz };
    tiempo_asignado_s: number;
    tiempo_restante_s: number;
  };
  via_A: DatosViaJSON;
  via_B: DatosViaJSON;
  config?: ConfigTiempos;
}

const DEFAULT_CONFIG: ConfigTiempos = {
  T_VERDE_VACIO: 5000,
  T_VERDE_APROX: 8000,
  T_VERDE_MODERADO: 10000,
  T_VERDE_CONGESTION: 15000,
  T_VERDE_MAX_ABS: 18000,
  T_EXTENSION_ONDA: 3000,
  T_AMARILLO: 3000,
  T_DESPEJE_ANTICIP: 2000,
  UMBRAL_S1_CM: 15.0,
  UMBRAL_S2_CM: 15.0,
};

const INITIAL_TELEMETRIA: TelemetriaArduino = {
  timestamp_ms: 0,
  evento: "SIN_CONEXION",
  semaforos: {
    via_A: { luz: "VERDE" },
    via_B: { luz: "ROJO" },
    tiempo_asignado_s: 10.0,
    tiempo_restante_s: 10.0,
  },
  via_A: {
    s1_parada_cm: 99.9,
    s1_ocupado: false,
    s2_cola_cm: 99.9,
    s2_ocupado: false,
    estado_trafico: "VACIO",
  },
  via_B: {
    s1_parada_cm: 99.9,
    s1_ocupado: false,
    s2_cola_cm: 99.9,
    s2_ocupado: false,
    estado_trafico: "VACIO",
  },
};

export default function DashboardInterseccion() {
  // Estado de conexión Serial
  const [conectado, setConectado] = useState(false);
  const [modoDemo, setModoDemo] = useState(false);
  const [baudRate, setBaudRate] = useState(115200);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);

  // Datos de telemetría recibidos del Arduino
  const [datos, setDatos] = useState<TelemetriaArduino>(INITIAL_TELEMETRIA);
  const [logsSerial, setLogsSerial] = useState<{ ts: string; dir: "RX" | "TX"; raw: string }[]>([]);
  const [historialEventos, setHistorialEventos] = useState<{ ts: string; evento: string }[]>([]);
  const [comandoManual, setComandoManual] = useState("");

  // Formulario de configuración de tiempos y umbrales
  const [configForm, setConfigForm] = useState<ConfigTiempos>(DEFAULT_CONFIG);

  // Controles de simulación manual para probar en Modo Demo
  const [simViaA_S1, setSimViaA_S1] = useState(45.0);
  const [simViaA_S2, setSimViaA_S2] = useState(60.0);
  const [simViaB_S1, setSimViaB_S1] = useState(10.5);
  const [simViaB_S2, setSimViaB_S2] = useState(50.0);

  // Referencias para Web Serial API
  const portRef = useRef< any >(null);
  const readerRef = useRef< any >(null);
  const keepReadingRef = useRef<boolean>(false);
  const ultimoEventoRef = useRef<string>("");

  // =========================================================================
  // PROCESAMIENTO DE LÍNEAS NDJSON ENTRANTES
  // =========================================================================
  const procesarLineaJSON = (linea: string) => {
    const limpia = linea.trim();
    if (!limpia) return;

    const hora = new Date().toLocaleTimeString();
    setLogsSerial((prev) => [{ ts: hora, dir: "RX" as const, raw: limpia }, ...prev.slice(0, 79)]);

    if (!limpia.startsWith("{")) return;

    try {
      const parsed: TelemetriaArduino = JSON.parse(limpia);
      setDatos(parsed);

      if (parsed.evento && parsed.evento !== ultimoEventoRef.current) {
        ultimoEventoRef.current = parsed.evento;
        setHistorialEventos((prev) => [
          { ts: `${(parsed.timestamp_ms / 1000).toFixed(1)}s`, evento: parsed.evento },
          ...prev.slice(0, 14),
        ]);
      }
    } catch {
      // Fragmento incompleto o mensaje de texto normal
    }
  };

  // =========================================================================
  // CONEXIÓN WEB SERIAL API (Arduino USB)
  // =========================================================================
  const conectarArduino = async () => {
    setErrorMsg(null);
    if (typeof window === "undefined" || !("serial" in navigator)) {
      setErrorMsg(
        "Tu navegador no soporta Web Serial API. Usa Google Chrome, Microsoft Edge o Brave en escritorio."
      );
      return;
    }

    try {
      if (modoDemo) setModoDemo(false);

      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate });

      portRef.current = port;
      keepReadingRef.current = true;
      setConectado(true);

      leerStreamSerial(port);
    } catch (err: any) {
      setErrorMsg(err?.message || "No se pudo abrir el puerto serial.");
    }
  };

  const leerStreamSerial = async (port: any) => {
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    readerRef.current = reader;

    let buffer = "";

    try {
      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lineas = buffer.split(/\r?\n/);
          buffer = lineas.pop() || "";
          for (const linea of lineas) {
            procesarLineaJSON(linea);
          }
        }
      }
    } catch (err: any) {
      console.error("Error leyendo serial:", err);
    } finally {
      reader.releaseLock();
      await readableStreamClosed.catch(() => {});
    }
  };

  const desconectarArduino = async () => {
    keepReadingRef.current = false;
    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
      }
      if (portRef.current) {
        await portRef.current.close();
      }
    } catch (e) {
      console.error(e);
    } finally {
      portRef.current = null;
      readerRef.current = null;
      setConectado(false);
    }
  };

  // =========================================================================
  // ENVÍO DE COMANDOS AL ARDUINO POR SERIAL
  // =========================================================================
  const enviarComandoSerial = async (comando: string) => {
    const linea = comando.trim() + "\n";
    const hora = new Date().toLocaleTimeString();

    setLogsSerial((prev) => [{ ts: hora, dir: "TX" as const, raw: comando.trim() }, ...prev.slice(0, 79)]);

    if (conectado && portRef.current?.writable) {
      try {
        const writer = portRef.current.writable.getWriter();
        const data = new TextEncoder().encode(linea);
        await writer.write(data);
        writer.releaseLock();
        mostrarFeedback(`Enviado: ${comando}`);
      } catch (err: any) {
        setErrorMsg("Error al enviar comando al Arduino: " + err?.message);
      }
    } else if (modoDemo) {
      mostrarFeedback(`Aplicado en Simulador: ${comando}`);
    } else {
      setErrorMsg("Conecta el Arduino o activa el Modo Simulador para enviar comandos.");
    }
  };

  const enviarTodosLosParametros = async () => {
    const entradas = Object.entries(configForm);
    for (const [clave, valor] of entradas) {
      await enviarComandoSerial(`${clave}=${valor}`);
      await new Promise((r) => setTimeout(r, 60)); // Pausa breve para no saturar buffer serial de Arduino
    }
    mostrarFeedback("Todos los tiempos y umbrales fueron enviados al Arduino");
  };

  const mostrarFeedback = (msg: string) => {
    setStatusFeedback(msg);
    setTimeout(() => setStatusFeedback(null), 3000);
  };

  // =========================================================================
  // SIMULADOR INTEGRADO (Idéntico a la máquina de estados del Arduino)
  // =========================================================================
  const simStateRef = useRef({
    estado: "A_VERDE_B_ROJO" as
      | "A_VERDE_B_ROJO"
      | "A_AMARILLO_B_ROJO"
      | "A_ROJO_B_VERDE"
      | "A_ROJO_B_AMARILLO",
    inicioFaseMs: 0,
    duracionFaseMs: 10000,
    inicioViaVaciaMs: 0,
    extensionUsada: false,
    motivo: "ARRANQUE_SIMULADOR",
    tiempoTotalMs: 0,
  });

  useEffect(() => {
    if (!modoDemo) return;

    const clasificar = (s1: boolean, s2: boolean): NivelTrafico => {
      if (!s1 && !s2) return "VACIO";
      if (!s1 && s2) return "APROXIMACION";
      if (s1 && !s2) return "MODERADO";
      return "CONGESTION_ALTA";
    };

    const calcVerde = (s1: boolean, s2: boolean) => {
      if (!s1 && !s2) return configForm.T_VERDE_VACIO;
      if (!s1 && s2) return configForm.T_VERDE_APROX;
      if (s1 && !s2) return configForm.T_VERDE_MODERADO;
      return configForm.T_VERDE_CONGESTION;
    };

    const interval = setInterval(() => {
      const st = simStateRef.current;
      st.tiempoTotalMs += 500;
      const ahora = st.tiempoTotalMs;
      const transcurrido = ahora - st.inicioFaseMs;

      const detA1 = simViaA_S1 <= configForm.UMBRAL_S1_CM;
      const detA2 = simViaA_S2 <= configForm.UMBRAL_S2_CM;
      const detB1 = simViaB_S1 <= configForm.UMBRAL_S1_CM;
      const detB2 = simViaB_S2 <= configForm.UMBRAL_S2_CM;

      const trafA = clasificar(detA1, detA2);
      const trafB = clasificar(detB1, detB2);

      const evaluarDinamicas = (
        actS1: boolean,
        actS2: boolean,
        espS1: boolean,
        espS2: boolean
      ) => {
        const restante = st.duracionFaseMs - transcurrido;
        // Regla 2: Corte anticipado
        if (!actS1 && !actS2 && (espS1 || espS2)) {
          if (st.inicioViaVaciaMs === 0) {
            st.inicioViaVaciaMs = ahora;
          } else if (
            ahora - st.inicioViaVaciaMs >= configForm.T_DESPEJE_ANTICIP &&
            restante > 1000
          ) {
            st.duracionFaseMs = transcurrido;
            st.motivo = "CORTE_ANTICIPADO_DESPEJE";
            return;
          }
        } else {
          st.inicioViaVaciaMs = 0;
        }

        // Regla 3 y 4: Extensión onda verde
        if (!st.extensionUsada && restante > 0 && restante <= 2000) {
          if (!actS1 && actS2) {
            const nueva = st.duracionFaseMs + configForm.T_EXTENSION_ONDA;
            if (nueva <= configForm.T_VERDE_MAX_ABS) {
              st.duracionFaseMs = nueva;
              st.extensionUsada = true;
              st.motivo = "EXTENSION_ONDA_VERDE_+3S";
            }
          }
        }
      };

      const cambiarEstado = (
        nuevo: typeof st.estado,
        duracion: number,
        motivo: string
      ) => {
        st.estado = nuevo;
        st.inicioFaseMs = ahora;
        st.duracionFaseMs = duracion;
        st.inicioViaVaciaMs = 0;
        st.extensionUsada = false;
        st.motivo = motivo;
      };

      if (st.estado === "A_VERDE_B_ROJO") {
        evaluarDinamicas(detA1, detA2, detB1, detB2);
        if (ahora - st.inicioFaseMs >= st.duracionFaseMs) {
          cambiarEstado("A_AMARILLO_B_ROJO", configForm.T_AMARILLO, "FIN_TIEMPO_VERDE_A");
        }
      } else if (st.estado === "A_AMARILLO_B_ROJO") {
        if (transcurrido >= configForm.T_AMARILLO) {
          cambiarEstado(
            "A_ROJO_B_VERDE",
            calcVerde(detB1, detB2),
            "TURNO_VIA_B_" + trafB
          );
        }
      } else if (st.estado === "A_ROJO_B_VERDE") {
        evaluarDinamicas(detB1, detB2, detA1, detA2);
        if (ahora - st.inicioFaseMs >= st.duracionFaseMs) {
          cambiarEstado("A_ROJO_B_AMARILLO", configForm.T_AMARILLO, "FIN_TIEMPO_VERDE_B");
        }
      } else if (st.estado === "A_ROJO_B_AMARILLO") {
        if (transcurrido >= configForm.T_AMARILLO) {
          cambiarEstado(
            "A_VERDE_B_ROJO",
            calcVerde(detA1, detA2),
            "TURNO_VIA_A_" + trafA
          );
        }
      }

      const luzA: ColorLuz =
        st.estado === "A_VERDE_B_ROJO"
          ? "VERDE"
          : st.estado === "A_AMARILLO_B_ROJO"
          ? "AMARILLO"
          : "ROJO";
      const luzB: ColorLuz =
        st.estado === "A_ROJO_B_VERDE"
          ? "VERDE"
          : st.estado === "A_ROJO_B_AMARILLO"
          ? "AMARILLO"
          : "ROJO";

      const restMs = Math.max(0, st.duracionFaseMs - (ahora - st.inicioFaseMs));

      const paqueteSimulado: TelemetriaArduino = {
        timestamp_ms: ahora,
        evento: st.motivo,
        semaforos: {
          via_A: { luz: luzA },
          via_B: { luz: luzB },
          tiempo_asignado_s: Number((st.duracionFaseMs / 1000).toFixed(1)),
          tiempo_restante_s: Number((restMs / 1000).toFixed(1)),
        },
        via_A: {
          s1_parada_cm: simViaA_S1,
          s1_ocupado: detA1,
          s2_cola_cm: simViaA_S2,
          s2_ocupado: detA2,
          estado_trafico: trafA,
        },
        via_B: {
          s1_parada_cm: simViaB_S1,
          s1_ocupado: detB1,
          s2_cola_cm: simViaB_S2,
          s2_ocupado: detB2,
          estado_trafico: trafB,
        },
      };

      procesarLineaJSON(JSON.stringify(paqueteSimulado));
    }, 500);

    return () => clearInterval(interval);
  }, [modoDemo, simViaA_S1, simViaA_S2, simViaB_S1, simViaB_S2, configForm]);

  // =========================================================================
  // HELPERS VISUALES
  // =========================================================================
  const badgeTrafico = (nivel: NivelTrafico) => {
    switch (nivel) {
      case "VACIO":
        return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
      case "APROXIMACION":
        return "bg-sky-500/15 text-sky-400 border-sky-500/30";
      case "MODERADO":
        return "bg-amber-500/15 text-amber-400 border-amber-500/30";
      case "CONGESTION_ALTA":
        return "bg-rose-500/20 text-rose-400 border-rose-500/40 animate-pulse";
    }
  };

  const porcentajeTiempo =
    datos.semaforos.tiempo_asignado_s > 0
      ? Math.min(
          100,
          Math.max(
            0,
            (datos.semaforos.tiempo_restante_s / datos.semaforos.tiempo_asignado_s) * 100
          )
        )
      : 0;

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 p-4 md:p-6 space-y-6">
      {/* BARRA SUPERIOR DE CONEXIÓN */}
      <header className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg md:text-xl font-bold tracking-tight text-white">
              Intersección Inteligente Adaptativa — Arduino Mega 2560
            </h1>
            <p className="text-xs md:text-sm text-slate-400">
              Telemetría NDJSON en Tiempo Real & Control de Tiempos por Puerto Serial (115200 baudios)
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto justify-end">
          {/* Estado actual */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-medium">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                conectado
                  ? "bg-emerald-400 animate-ping"
                  : modoDemo
                  ? "bg-amber-400 animate-pulse"
                  : "bg-slate-600"
              }`}
            />
            <span>
              {conectado
                ? "CONECTADO POR USB SERIAL"
                : modoDemo
                ? "MODO SIMULADOR ACTIVO"
                : "DESCONECTADO"}
            </span>
          </div>

          {/* Selector de Baudios */}
          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={conectado}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
          >
            <option value={115200}>115200 baudios</option>
            <option value={9600}>9600 baudios</option>
            <option value={57600}>57600 baudios</option>
          </select>

          {/* Botón Simulador */}
          <button
            onClick={() => {
              if (conectado) desconectarArduino();
              setModoDemo(!modoDemo);
            }}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border transition ${
              modoDemo
                ? "bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30"
                : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
            }`}
          >
            {modoDemo ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {modoDemo ? "Detener Simulador" : "Simulador Demo"}
          </button>

          {/* Botón Conectar Arduino */}
          {!conectado ? (
            <button
              onClick={conectarArduino}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25 transition"
            >
              <Usb className="w-4 h-4" />
              Conectar Arduino (Serial)
            </button>
          ) : (
            <button
              onClick={desconectarArduino}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/25 transition"
            >
              <Unplug className="w-4 h-4" />
              Desconectar
            </button>
          )}
        </div>
      </header>

      {/* ALERTAS Y NOTIFICACIONES */}
      {errorMsg && (
        <div className="bg-rose-950/60 border border-rose-500/40 text-rose-200 px-4 py-3 rounded-xl flex items-center justify-between text-sm">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            onClick={() => setErrorMsg(null)}
            className="text-xs underline text-rose-300 hover:text-white"
          >
            Cerrar
          </button>
        </div>
      )}

      {statusFeedback && (
        <div className="bg-emerald-950/60 border border-emerald-500/40 text-emerald-200 px-4 py-2.5 rounded-xl flex items-center gap-2 text-xs font-medium">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{statusFeedback}</span>
        </div>
      )}

      {/* FILA DE KPIs GENERALES DE LA INTERSECCIÓN */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Tiempo Restante de Fase */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>TIEMPO RESTANTE DE FASE</span>
            <Clock className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="my-2 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">
              {datos.semaforos.tiempo_restante_s.toFixed(1)}s
            </span>
            <span className="text-xs text-slate-400">
              / {datos.semaforos.tiempo_asignado_s.toFixed(1)}s asignados
            </span>
          </div>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
            <div
              className="bg-indigo-500 h-full transition-all duration-300"
              style={{ width: `${porcentajeTiempo}%` }}
            />
          </div>
        </div>

        {/* Último Evento / Motivo de Cambio */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>MOTIVO / EVENTO ACTIVO</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="my-2">
            <span className="inline-block px-2.5 py-1 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-mono text-xs md:text-sm font-bold break-all">
              {datos.evento}
            </span>
          </div>
          <span className="text-[11px] text-slate-500">
            Reglas dinámicas (Onda Verde / Despeje Temprano)
          </span>
        </div>

        {/* Uptime del Arduino */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>TIMESTAMP ARDUINO (MILLIS)</span>
            <Radio className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="my-2">
            <span className="text-2xl font-bold font-mono text-slate-100">
              {(datos.timestamp_ms / 1000).toFixed(1)} s
            </span>
            <p className="text-xs text-slate-500 font-mono">{datos.timestamp_ms} ms</p>
          </div>
          <span className="text-[11px] text-slate-500">Reporte periódico cada 500 ms</span>
        </div>

        {/* Control Manual de Fase Rápido */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>CONTROL MANUAL DE EMERGENCIA</span>
            <RefreshCw className="w-4 h-4 text-sky-400" />
          </div>
          <div className="grid grid-cols-2 gap-2 my-2">
            <button
              onClick={() => {
                if (modoDemo) {
                  simStateRef.current.estado = "A_VERDE_B_ROJO";
                  simStateRef.current.inicioFaseMs = simStateRef.current.tiempoTotalMs;
                  simStateRef.current.duracionFaseMs = configForm.T_VERDE_MODERADO;
                  simStateRef.current.motivo = "CAMBIO_MANUAL_WEB_VIA_A";
                }
                enviarComandoSerial("FORZAR_FASE=A");
              }}
              className="px-2.5 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-xs font-semibold transition"
            >
              Dar Verde Vía A
            </button>
            <button
              onClick={() => {
                if (modoDemo) {
                  simStateRef.current.estado = "A_ROJO_B_VERDE";
                  simStateRef.current.inicioFaseMs = simStateRef.current.tiempoTotalMs;
                  simStateRef.current.duracionFaseMs = configForm.T_VERDE_MODERADO;
                  simStateRef.current.motivo = "CAMBIO_MANUAL_WEB_VIA_B";
                }
                enviarComandoSerial("FORZAR_FASE=B");
              }}
              className="px-2.5 py-2 rounded-xl bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/30 text-sky-300 text-xs font-semibold transition"
            >
              Dar Verde Vía B
            </button>
          </div>
          <span className="text-[11px] text-slate-500">Envía FORZAR_FASE=A/B por Serial</span>
        </div>
      </div>

      {/* PANELES PRINCIPALES: VÍA A Y VÍA B */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ==================== TARJETA VÍA A ==================== */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col sm:flex-row gap-6 items-center">
          {/* Semáforo Gráfico Vía A */}
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 flex sm:flex-col gap-3 shrink-0 shadow-inner">
            <div
              className={`w-12 h-12 rounded-full transition-all duration-300 ${
                datos.semaforos.via_A.luz === "ROJO"
                  ? "bg-red-500 shadow-[0_0_25px_#ef4444] scale-105"
                  : "bg-red-950/40 border border-red-900/30"
              }`}
            />
            <div
              className={`w-12 h-12 rounded-full transition-all duration-300 ${
                datos.semaforos.via_A.luz === "AMARILLO"
                  ? "bg-amber-400 shadow-[0_0_25px_#fbbf24] scale-105"
                  : "bg-amber-950/40 border border-amber-900/30"
              }`}
            />
            <div
              className={`w-12 h-12 rounded-full transition-all duration-300 ${
                datos.semaforos.via_A.luz === "VERDE"
                  ? "bg-emerald-500 shadow-[0_0_25px_#10b981] scale-105"
                  : "bg-emerald-950/40 border border-emerald-900/30"
              }`}
            />
          </div>

          {/* Detalles y Sensores Vía A */}
          <div className="flex-1 w-full space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-indigo-400">
                  Pines LED: 2, 3, 4
                </span>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  VÍA A (Principal)
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    Luz: {datos.semaforos.via_A.luz}
                  </span>
                </h2>
              </div>
              <span
                className={`px-3 py-1 rounded-full text-xs font-bold border ${badgeTrafico(
                  datos.via_A.estado_trafico
                )}`}
              >
                {datos.via_A.estado_trafico}
              </span>
            </div>

            {/* Sensores S1A y S2A */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Sensor S1A - Línea de Parada */}
              <div
                className={`p-3.5 rounded-xl border transition ${
                  datos.via_A.s1_ocupado
                    ? "bg-rose-500/10 border-rose-500/40"
                    : "bg-slate-950/70 border-slate-800"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>S1A - PARADA (Pin 22/23)</span>
                  <Car
                    className={`w-4 h-4 ${
                      datos.via_A.s1_ocupado ? "text-rose-400" : "text-slate-600"
                    }`}
                  />
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold font-mono text-white">
                    {datos.via_A.s1_parada_cm.toFixed(1)} cm
                  </span>
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded ${
                      datos.via_A.s1_ocupado
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {datos.via_A.s1_ocupado ? "AUTO DETECTADO" : "LIBRE"}
                  </span>
                </div>
                {modoDemo && (
                  <div className="mt-3 pt-2 border-t border-slate-800/80">
                    <label className="text-[11px] text-slate-400 flex justify-between">
                      <span>Simular distancia S1A:</span>
                      <span>{simViaA_S1} cm</span>
                    </label>
                    <input
                      type="range"
                      min="2"
                      max="99.9"
                      step="0.5"
                      value={simViaA_S1}
                      onChange={(e) => setSimViaA_S1( parseFloat(e.target.value) )}
                      className="w-full accent-indigo-500 mt-1"
                    />
                  </div>
                )}
              </div>

              {/* Sensor S2A - Cola / Aproximación */}
              <div
                className={`p-3.5 rounded-xl border transition ${
                  datos.via_A.s2_ocupado
                    ? "bg-amber-500/10 border-amber-500/40"
                    : "bg-slate-950/70 border-slate-800"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>S2A - COLA (Pin 24/25)</span>
                  <Car
                    className={`w-4 h-4 ${
                      datos.via_A.s2_ocupado ? "text-amber-400" : "text-slate-600"
                    }`}
                  />
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold font-mono text-white">
                    {datos.via_A.s2_cola_cm.toFixed(1)} cm
                  </span>
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded ${
                      datos.via_A.s2_ocupado
                        ? "bg-amber-500/20 text-amber-300"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {datos.via_A.s2_ocupado ? "COLA / APROX" : "LIBRE"}
                  </span>
                </div>
                {modoDemo && (
                  <div className="mt-3 pt-2 border-t border-slate-800/80">
                    <label className="text-[11px] text-slate-400 flex justify-between">
                      <span>Simular distancia S2A:</span>
                      <span>{simViaA_S2} cm</span>
                    </label>
                    <input
                      type="range"
                      min="2"
                      max="99.9"
                      step="0.5"
                      value={simViaA_S2}
                      onChange={(e) => setSimViaA_S2( parseFloat(e.target.value) )}
                      className="w-full accent-indigo-500 mt-1"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ==================== TARJETA VÍA B ==================== */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col sm:flex-row gap-6 items-center">
          {/* Semáforo Gráfico Vía B */}
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 flex sm:flex-col gap-3 shrink-0 shadow-inner">
            <div
              className={`w-12 h-12 rounded-full transition-all duration-300 ${
                datos.semaforos.via_B.luz === "ROJO"
                  ? "bg-red-500 shadow-[0_0_25px_#ef4444] scale-105"
                  : "bg-red-950/40 border border-red-900/30"
              }`}
            />
            <div
              className={`w-12 h-12 rounded-full transition-all duration-300 ${
                datos.semaforos.via_B.luz === "AMARILLO"
                  ? "bg-amber-400 shadow-[0_0_25px_#fbbf24] scale-105"
                  : "bg-amber-950/40 border border-amber-900/30"
              }`}
            />
            <div
              className={`w-12 h-12 rounded-full transition-all duration-300 ${
                datos.semaforos.via_B.luz === "VERDE"
                  ? "bg-emerald-500 shadow-[0_0_25px_#10b981] scale-105"
                  : "bg-emerald-950/40 border border-emerald-900/30"
              }`}
            />
          </div>

          {/* Detalles y Sensores Vía B */}
          <div className="flex-1 w-full space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-sky-400">
                  Pines LED: 5, 6, 7
                </span>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  VÍA B (Secundaria)
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    Luz: {datos.semaforos.via_B.luz}
                  </span>
                </h2>
              </div>
              <span
                className={`px-3 py-1 rounded-full text-xs font-bold border ${badgeTrafico(
                  datos.via_B.estado_trafico
                )}`}
              >
                {datos.via_B.estado_trafico}
              </span>
            </div>

            {/* Sensores S1B y S2B */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Sensor S1B - Línea de Parada */}
              <div
                className={`p-3.5 rounded-xl border transition ${
                  datos.via_B.s1_ocupado
                    ? "bg-rose-500/10 border-rose-500/40"
                    : "bg-slate-950/70 border-slate-800"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>S1B - PARADA (Pin 26/27)</span>
                  <Car
                    className={`w-4 h-4 ${
                      datos.via_B.s1_ocupado ? "text-rose-400" : "text-slate-600"
                    }`}
                  />
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold font-mono text-white">
                    {datos.via_B.s1_parada_cm.toFixed(1)} cm
                  </span>
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded ${
                      datos.via_B.s1_ocupado
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {datos.via_B.s1_ocupado ? "AUTO DETECTADO" : "LIBRE"}
                  </span>
                </div>
                {modoDemo && (
                  <div className="mt-3 pt-2 border-t border-slate-800/80">
                    <label className="text-[11px] text-slate-400 flex justify-between">
                      <span>Simular distancia S1B:</span>
                      <span>{simViaB_S1} cm</span>
                    </label>
                    <input
                      type="range"
                      min="2"
                      max="99.9"
                      step="0.5"
                      value={simViaB_S1}
                      onChange={(e) => setSimViaB_S1( parseFloat(e.target.value) )}
                      className="w-full accent-sky-500 mt-1"
                    />
                  </div>
                )}
              </div>

              {/* Sensor S2B - Cola / Aproximación */}
              <div
                className={`p-3.5 rounded-xl border transition ${
                  datos.via_B.s2_ocupado
                    ? "bg-amber-500/10 border-amber-500/40"
                    : "bg-slate-950/70 border-slate-800"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>S2B - COLA (Pin 28/29)</span>
                  <Car
                    className={`w-4 h-4 ${
                      datos.via_B.s2_ocupado ? "text-amber-400" : "text-slate-600"
                    }`}
                  />
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold font-mono text-white">
                    {datos.via_B.s2_cola_cm.toFixed(1)} cm
                  </span>
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded ${
                      datos.via_B.s2_ocupado
                        ? "bg-amber-500/20 text-amber-300"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {datos.via_B.s2_ocupado ? "COLA / APROX" : "LIBRE"}
                  </span>
                </div>
                {modoDemo && (
                  <div className="mt-3 pt-2 border-t border-slate-800/80">
                    <label className="text-[11px] text-slate-400 flex justify-between">
                      <span>Simular distancia S2B:</span>
                      <span>{simViaB_S2} cm</span>
                    </label>
                    <input
                      type="range"
                      min="2"
                      max="99.9"
                      step="0.5"
                      value={simViaB_S2}
                      onChange={(e) => setSimViaB_S2( parseFloat(e.target.value) )}
                      className="w-full accent-sky-500 mt-1"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECCIÓN INFERIOR: CONFIGURACIÓN DE TIEMPOS Y CONSOLA SERIAL */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* PANEL DE AJUSTE DE TIEMPOS Y UMBRALES (7 columnas) */}
        <div className="xl:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2.5">
              <Sliders className="w-5 h-5 text-indigo-400" />
              <div>
                <h3 className="text-base font-bold text-white">
                  Configuración de Tiempos de Fase y Calibración Ultrasónica
                </h3>
                <p className="text-xs text-slate-400">
                  Modifica los valores en segundos/cm y envíalos en caliente al Arduino por Serial
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfigForm(DEFAULT_CONFIG)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
              >
                Restaurar por Defecto
              </button>
              <button
                onClick={enviarTodosLosParametros}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md transition"
              >
                <Send className="w-3.5 h-3.5" />
                Aplicar Todo al Arduino
              </button>
            </div>
          </div>

          {/* Grid de inputs de tiempos */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {[
              {
                key: "T_VERDE_VACIO",
                label: "Verde Vacío (S1=0, S2=0)",
                unit: "s",
                isMs: true,
              },
              {
                key: "T_VERDE_APROX",
                label: "Verde Aprox (S1=0, S2=1)",
                unit: "s",
                isMs: true,
              },
              {
                key: "T_VERDE_MODERADO",
                label: "Verde Moderado (S1=1, S2=0)",
                unit: "s",
                isMs: true,
              },
              {
                key: "T_VERDE_CONGESTION",
                label: "Verde Congestión (S1=1, S2=1)",
                unit: "s",
                isMs: true,
              },
              {
                key: "T_VERDE_MAX_ABS",
                label: "Tope Máximo Verde (Anti-Inanición)",
                unit: "s",
                isMs: true,
              },
              {
                key: "T_EXTENSION_ONDA",
                label: "Extensión Onda Verde (+S2)",
                unit: "s",
                isMs: true,
              },
              {
                key: "T_AMARILLO",
                label: "Tiempo Amarillo Seguridad",
                unit: "s",
                isMs: true,
              },
              {
                key: "T_DESPEJE_ANTICIP",
                label: "Corte Anticipado Vía Vacía",
                unit: "s",
                isMs: true,
              },
              {
                key: "UMBRAL_S1_CM",
                label: "Umbral Detección Parada S1",
                unit: "cm",
                isMs: false,
              },
              {
                key: "UMBRAL_S2_CM",
                label: "Umbral Detección Cola S2",
                unit: "cm",
                isMs: false,
              },
            ].map((item) => {
              const rawVal = configForm[item.key as keyof ConfigTiempos];
              const displayVal = item.isMs ? rawVal / 1000 : rawVal;

              return (
                <div
                  key={item.key}
                  className="bg-slate-950/80 border border-slate-800/90 rounded-xl p-3 flex flex-col justify-between"
                >
                  <label className="text-xs font-medium text-slate-300 mb-2">
                    {item.label}
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type="number"
                        step={item.isMs ? "0.5" : "0.5"}
                        min="0.5"
                        value={displayVal}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value) || 0;
                          setConfigForm((prev) => ({
                            ...prev,
                            [item.key]: item.isMs ? Math.round(v * 1000) : v,
                          }));
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-indigo-500"
                      />
                      <span className="absolute right-2.5 top-1.5 text-xs text-slate-500 font-mono">
                        {item.unit}
                      </span>
                    </div>
                    <button
                      title={`Enviar ${item.key}=${rawVal}`}
                      onClick={() => enviarComandoSerial(`${item.key}=${rawVal}`)}
                      className="px-2.5 py-1.5 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/30 border border-indigo-500/30 text-indigo-300 text-xs font-semibold transition"
                    >
                      Enviar
                    </button>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono mt-1.5">
                    {item.key}={rawVal}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* MONITOR SERIAL NDJSON EN VIVO Y BITÁCORA (5 columnas) */}
        <div className="xl:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-emerald-400" />
              <div>
                <h3 className="text-base font-bold text-white">Monitor Serial NDJSON</h3>
                <p className="text-xs text-slate-400">
                  Tramas recibidas desde Arduino y comandos enviados
                </p>
              </div>
            </div>
            <button
              onClick={() => setLogsSerial([])}
              className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded bg-slate-800"
            >
              Limpiar
            </button>
          </div>

          {/* Historial rápido de cambios de fase */}
          {historialEventos.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <span className="text-[11px] text-slate-400 shrink-0">Eventos:</span>
              {historialEventos.slice(0, 4).map((ev, i) => (
                <span
                  key={i}
                  className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 shrink-0"
                >
                  [{ev.ts}] {ev.evento}
                </span>
              ))}
            </div>
          )}

          {/* Consola Serial */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 h-64 overflow-y-auto font-mono text-xs space-y-1.5">
            {logsSerial.length === 0 ? (
              <p className="text-slate-600 text-center py-20">
                Esperando tramas JSON del puerto serial (115200 baudios)...
              </p>
            ) : (
              logsSerial.map((log, idx) => (
                <div
                  key={idx}
                  className={`break-all leading-relaxed ${
                    log.dir === "TX"
                      ? "text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded"
                      : "text-emerald-400/90"
                  }`}
                >
                  <span className="text-slate-500 mr-2">[{log.ts}]</span>
                  <span className="font-bold mr-1.5">
                    {log.dir === "TX" ? "TX >>" : "RX <<"}
                  </span>
                  <span>{log.raw}</span>
                </div>
              ))
            )}
          </div>

          {/* Envío de comando manual por Serial */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!comandoManual.trim()) return;
              enviarComandoSerial(comandoManual);
              setComandoManual("");
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              placeholder="Ej: T_VERDE_VACIO=6000 o FORZAR_FASE=A"
              value={comandoManual}
              onChange={(e) => setComandoManual(e.target.value)}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition flex items-center gap-1.5"
            >
              <Send className="w-3.5 h-3.5" />
              Enviar
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
