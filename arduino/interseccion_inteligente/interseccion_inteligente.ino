// =========================================================================
// INTERSECCIÓN INTELIGENTE ADAPTATIVA - ARDUINO MEGA 2560
// Salida estructurada en JSON (NDJSON) y recepción de comandos por Serial a 115200 baudios
// =========================================================================

// --- PINES SEMÁFORO A ---
const int PIN_A_ROJO     = 2;
const int PIN_A_AMARILLO = 3;
const int PIN_A_VERDE    = 4;

// --- PINES SEMÁFORO B ---
const int PIN_B_ROJO     = 5;
const int PIN_B_AMARILLO = 6;
const int PIN_B_VERDE    = 7;

// --- PINES SENSORES ULTRASÓNICOS (TRIG / ECHO) ---
const int S1A_TRIG = 22, S1A_ECHO = 23; // Vía A - Parada (debajo semáforo)
const int S2A_TRIG = 24, S2A_ECHO = 25; // Vía A - Cola (final de vía)
const int S1B_TRIG = 26, S1B_ECHO = 27; // Vía B - Parada (debajo semáforo)
const int S2B_TRIG = 28, S2B_ECHO = 29; // Vía B - Cola (final de vía)

// --- PARÁMETROS DE CALIBRACIÓN DE MAQUETA (Modificables desde Dashboard) ---
float UMBRAL_S1_CM = 15.0; // Detecta auto en línea de parada (< 15 cm)
float UMBRAL_S2_CM = 15.0; // Detecta auto en cola / aproximación (< 15 cm)

// --- TIEMPOS DE FASE (en milisegundos, Modificables desde Dashboard) ---
unsigned long T_VERDE_VACIO      = 5000;  // S1=0, S2=0
unsigned long T_VERDE_APROX      = 8000;  // S1=0, S2=1 (Onda verde)
unsigned long T_VERDE_MODERADO   = 10000; // S1=1, S2=0
unsigned long T_VERDE_CONGESTION = 15000; // S1=1, S2=1
unsigned long T_VERDE_MAX_ABS    = 18000; // Regla anti-inanición (tope)
unsigned long T_EXTENSION_ONDA   = 3000;  // Extensión por aproximación
unsigned long T_AMARILLO         = 3000;  // Amarillo fijo de seguridad
unsigned long T_DESPEJE_ANTICIP  = 2000;  // Tiempo libre para corte anticipado

// --- MÁQUINA DE ESTADOS DEL SEMÁFORO ---
enum EstadoSemaforo {
  A_VERDE_B_ROJO,
  A_AMARILLO_B_ROJO,
  A_ROJO_B_VERDE,
  A_ROJO_B_AMARILLO
};

EstadoSemaforo estadoActual = A_VERDE_B_ROJO;

// --- VARIABLES DE CONTROL DE TIEMPO ---
unsigned long inicioFaseMs     = 0;
unsigned long duracionFaseMs   = T_VERDE_MODERADO;
unsigned long inicioViaVaciaMs = 0;
unsigned long ultimoReporteMs  = 0;
bool extensionUsadaEnCiclo     = false;
String motivoUltimoCambio      = "INICIO_SISTEMA";

// --- ESTRUCTURA DE DATOS DE SENSORES ---
struct DatosVia {
  float distS1;
  float distS2;
  bool detS1;
  bool detS2;
  String nivelTrafico;
};

DatosVia viaA, viaB;

// Buffer para comandos seriales entrantes desde la web
String bufferSerial = "";

// =========================================================================
// CONFIGURACIÓN INICIAL
// =========================================================================
void setup() {
  Serial.begin(115200); // Alta velocidad recomendada para telemetría JSON

  // Configurar LEDs
  int pinesLed[] = {PIN_A_ROJO, PIN_A_AMARILLO, PIN_A_VERDE, PIN_B_ROJO, PIN_B_AMARILLO, PIN_B_VERDE};
  for (int i = 0; i < 6; i++) {
    pinMode(pinesLed[i], OUTPUT);
    digitalWrite(pinesLed[i], LOW);
  }

  // Configurar Sensores
  int pinesTrig[] = {S1A_TRIG, S2A_TRIG, S1B_TRIG, S2B_TRIG};
  int pinesEcho[] = {S1A_ECHO, S2A_ECHO, S1B_ECHO, S2B_ECHO};
  for (int i = 0; i < 4; i++) {
    pinMode(pinesTrig[i], OUTPUT);
    digitalWrite(pinesTrig[i], LOW);
    pinMode(pinesEcho[i], INPUT);
  }

  // Lectura inicial y arranque en Vía A Verde
  actualizarSensores();
  iniciarFase(A_VERDE_B_ROJO, calcularTiempoVerde(viaA), "ARRANQUE_INICIAL");
}

// =========================================================================
// BUCLE PRINCIPAL
// =========================================================================
void loop() {
  // 0. Leer posibles comandos de configuración desde el Dashboard Web
  leerComandosSerial();

  unsigned long ahora = millis();

  // 1. Leer sensores secuencialmente (evita crosstalk ultrasónico)
  actualizarSensores();

  // 2. Evaluar lógica de estados y reglas adaptativas
  unsigned long transcurrido = ahora - inicioFaseMs;

  switch (estadoActual) {
    case A_VERDE_B_ROJO:
      evaluarReglasDinamicas(viaA, viaB, transcurrido, ahora);
      if (transcurrido >= duracionFaseMs) {
        iniciarFase(A_AMARILLO_B_ROJO, T_AMARILLO, "FIN_TIEMPO_VERDE_A");
      }
      break;

    case A_AMARILLO_B_ROJO:
      if (transcurrido >= T_AMARILLO) {
        unsigned long tB = calcularTiempoVerde(viaB);
        iniciarFase(A_ROJO_B_VERDE, tB, "TURNO_VIA_B_" + viaB.nivelTrafico);
      }
      break;

    case A_ROJO_B_VERDE:
      evaluarReglasDinamicas(viaB, viaA, transcurrido, ahora);
      if (transcurrido >= duracionFaseMs) {
        iniciarFase(A_ROJO_B_AMARILLO, T_AMARILLO, "FIN_TIEMPO_VERDE_B");
      }
      break;

    case A_ROJO_B_AMARILLO:
      if (transcurrido >= T_AMARILLO) {
        unsigned long tA = calcularTiempoVerde(viaA);
        iniciarFase(A_VERDE_B_ROJO, tA, "TURNO_VIA_A_" + viaA.nivelTrafico);
      }
      break;
  }

  // 3. Emitir JSON estructurado cada 500 ms para el Dashboard
  if (ahora - ultimoReporteMs >= 500) {
    ultimoReporteMs = ahora;
    enviarTelemetriaJSON(ahora);
  }
}

// =========================================================================
// RECEPCIÓN DE COMANDOS DESDE EL DASHBOARD WEB (Formato: CLAVE=VALOR\n)
// Comandos soportados:
// T_VERDE_VACIO=5000
// T_VERDE_APROX=8000
// T_VERDE_MODERADO=10000
// T_VERDE_CONGESTION=15000
// T_VERDE_MAX_ABS=18000
// T_EXTENSION_ONDA=3000
// T_AMARILLO=3000
// T_DESPEJE_ANTICIP=2000
// UMBRAL_S1_CM=15.0
// UMBRAL_S2_CM=15.0
// FORZAR_FASE=A  | FORZAR_FASE=B
// =========================================================================
void leerComandosSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (bufferSerial.length() > 0) {
        procesarComando(bufferSerial);
        bufferSerial = "";
      }
    } else {
      bufferSerial += c;
    }
  }
}

void procesarComando(String cmd) {
  cmd.trim();
  int sep = cmd.indexOf('=');
  if (sep == -1) return;

  String clave = cmd.substring(0, sep);
  String valorStr = cmd.substring(sep + 1);
  clave.trim();
  valorStr.trim();

  if (clave == "T_VERDE_VACIO")           T_VERDE_VACIO      = valorStr.toInt();
  else if (clave == "T_VERDE_APROX")      T_VERDE_APROX      = valorStr.toInt();
  else if (clave == "T_VERDE_MODERADO")   T_VERDE_MODERADO   = valorStr.toInt();
  else if (clave == "T_VERDE_CONGESTION") T_VERDE_CONGESTION = valorStr.toInt();
  else if (clave == "T_VERDE_MAX_ABS")    T_VERDE_MAX_ABS    = valorStr.toInt();
  else if (clave == "T_EXTENSION_ONDA")   T_EXTENSION_ONDA   = valorStr.toInt();
  else if (clave == "T_AMARILLO")         T_AMARILLO         = valorStr.toInt();
  else if (clave == "T_DESPEJE_ANTICIP")  T_DESPEJE_ANTICIP  = valorStr.toInt();
  else if (clave == "UMBRAL_S1_CM")       UMBRAL_S1_CM       = valorStr.toFloat();
  else if (clave == "UMBRAL_S2_CM")       UMBRAL_S2_CM       = valorStr.toFloat();
  else if (clave == "FORZAR_FASE") {
    if (valorStr == "A" && estadoActual != A_VERDE_B_ROJO) {
      iniciarFase(A_VERDE_B_ROJO, calcularTiempoVerde(viaA), "CAMBIO_MANUAL_WEB_VIA_A");
      return;
    } else if (valorStr == "B" && estadoActual != A_ROJO_B_VERDE) {
      iniciarFase(A_ROJO_B_VERDE, calcularTiempoVerde(viaB), "CAMBIO_MANUAL_WEB_VIA_B");
      return;
    }
  }

  motivoUltimoCambio = "CONFIG_ACTUALIZADA_" + clave;
  enviarTelemetriaJSON(millis());
}

// =========================================================================
// LECTURA DE SENSORES (Secuencial con pausa anti-interferencia)
// =========================================================================
float medirDistanciaCm(int trigPin, int echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  // Timeout de 15ms (~250 cm máx) para no bloquear el loop
  long duracion = pulseIn(echoPin, HIGH, 15000);
  if (duracion == 0) return 99.9; // Sin eco dentro del rango de maqueta
  return (duracion * 0.0343) / 2.0;
}

void actualizarSensores() {
  viaA.distS1 = medirDistanciaCm(S1A_TRIG, S1A_ECHO);
  delay(25); // Pausa acústica entre sensores
  viaA.distS2 = medirDistanciaCm(S2A_TRIG, S2A_ECHO);
  delay(25);
  viaB.distS1 = medirDistanciaCm(S1B_TRIG, S1B_ECHO);
  delay(25);
  viaB.distS2 = medirDistanciaCm(S2B_TRIG, S2B_ECHO);
  delay(25);

  viaA.detS1 = (viaA.distS1 <= UMBRAL_S1_CM);
  viaA.detS2 = (viaA.distS2 <= UMBRAL_S2_CM);
  viaA.nivelTrafico = clasificarTrafico(viaA.detS1, viaA.detS2);

  viaB.detS1 = (viaB.distS1 <= UMBRAL_S1_CM);
  viaB.detS2 = (viaB.distS2 <= UMBRAL_S2_CM);
  viaB.nivelTrafico = clasificarTrafico(viaB.detS1, viaB.detS2);
}

String clasificarTrafico(bool s1, bool s2) {
  if (!s1 && !s2) return "VACIO";
  if (!s1 && s2)  return "APROXIMACION";
  if (s1 && !s2)  return "MODERADO";
  return "CONGESTION_ALTA";
}

// =========================================================================
// REGLAS ADAPTATIVAS (Reglas 1, 2, 3 y 4)
// =========================================================================
unsigned long calcularTiempoVerde(DatosVia via) {
  if (!via.detS1 && !via.detS2) return T_VERDE_VACIO;
  if (!via.detS1 && via.detS2)  return T_VERDE_APROX;
  if (via.detS1 && !via.detS2)  return T_VERDE_MODERADO;
  return T_VERDE_CONGESTION;
}

void evaluarReglasDinamicas(DatosVia &viaActiva, DatosVia &viaEspera, unsigned long transcurrido, unsigned long ahora) {
  long restante = (long)duracionFaseMs - (long)transcurrido;

  // REGLA 2: Corte anticipado por despeje temprano
  // Si la vía en verde quedó vacía (S1=0 y S2=0) por 2s y la otra vía tiene autos esperando
  if (!viaActiva.detS1 && !viaActiva.detS2 && (viaEspera.detS1 || viaEspera.detS2)) {
    if (inicioViaVaciaMs == 0) {
      inicioViaVaciaMs = ahora;
    } else if (ahora - inicioViaVaciaMs >= T_DESPEJE_ANTICIP && restante > 1000) {
      duracionFaseMs = transcurrido; // Fuerza el paso inmediato a Amarillo
      motivoUltimoCambio = "CORTE_ANTICIPADO_DESPEJE";
      return;
    }
  } else {
    inicioViaVaciaMs = 0; // Reinicia contador si vuelve a pasar un auto
  }

  // REGLA 3 y 4: Extensión de Onda Verde (+3s) respetando tope máximo de 18s
  if (!extensionUsadaEnCiclo && restante > 0 && restante <= 2000) {
    if (!viaActiva.detS1 && viaActiva.detS2) {
      unsigned long nuevaDuracion = duracionFaseMs + T_EXTENSION_ONDA;
      if (nuevaDuracion <= T_VERDE_MAX_ABS) {
        duracionFaseMs = nuevaDuracion;
        extensionUsadaEnCiclo = true;
        motivoUltimoCambio = "EXTENSION_ONDA_VERDE_+3S";
      }
    }
  }
}

// =========================================================================
// CONTROL DE LUCES Y CAMBIO DE ESTADO
// =========================================================================
void iniciarFase(EstadoSemaforo nuevoEstado, unsigned long duracionMs, String motivo) {
  estadoActual          = nuevoEstado;
  inicioFaseMs          = millis();
  duracionFaseMs        = duracionMs;
  inicioViaVaciaMs      = 0;
  extensionUsadaEnCiclo = false;
  motivoUltimoCambio    = motivo;

  // Apagar todos los LEDs antes de encender la combinación segura
  digitalWrite(PIN_A_ROJO, LOW);
  digitalWrite(PIN_A_AMARILLO, LOW);
  digitalWrite(PIN_A_VERDE, LOW);
  digitalWrite(PIN_B_ROJO, LOW);
  digitalWrite(PIN_B_AMARILLO, LOW);
  digitalWrite(PIN_B_VERDE, LOW);

  switch (estadoActual) {
    case A_VERDE_B_ROJO:
      digitalWrite(PIN_A_VERDE, HIGH);
      digitalWrite(PIN_B_ROJO, HIGH);
      break;
    case A_AMARILLO_B_ROJO:
      digitalWrite(PIN_A_AMARILLO, HIGH);
      digitalWrite(PIN_B_ROJO, HIGH);
      break;
    case A_ROJO_B_VERDE:
      digitalWrite(PIN_A_ROJO, HIGH);
      digitalWrite(PIN_B_VERDE, HIGH);
      break;
    case A_ROJO_B_AMARILLO:
      digitalWrite(PIN_A_ROJO, HIGH);
      digitalWrite(PIN_B_AMARILLO, HIGH);
      break;
  }

  // Enviar un JSON inmediato en el instante exacto del cambio de luz
  enviarTelemetriaJSON(inicioFaseMs);
}

// =========================================================================
// CONSTRUCCIÓN DE JSON ESTRUCTURADO PARA DASHBOARD
// =========================================================================
void enviarTelemetriaJSON(unsigned long timestampMs) {
  unsigned long transcurrido = timestampMs - inicioFaseMs;
  long restanteMs = (long)duracionFaseMs - (long)transcurrido;
  if (restanteMs < 0) restanteMs = 0;

  String luzA = (estadoActual == A_VERDE_B_ROJO) ? "VERDE" :
                (estadoActual == A_AMARILLO_B_ROJO) ? "AMARILLO" : "ROJO";

  String luzB = (estadoActual == A_ROJO_B_VERDE) ? "VERDE" :
                (estadoActual == A_ROJO_B_AMARILLO) ? "AMARILLO" : "ROJO";

  // Construcción de objeto JSON en una sola línea (NDJSON)
  Serial.print("{");
  Serial.print("\"timestamp_ms\":"); Serial.print(timestampMs); Serial.print(",");
  Serial.print("\"evento\":\""); Serial.print(motivoUltimoCambio); Serial.print("\",");

  // Objeto Semáforos
  Serial.print("\"semaforos\":{");
    Serial.print("\"via_A\":{\"luz\":\""); Serial.print(luzA); Serial.print("\"},");
    Serial.print("\"via_B\":{\"luz\":\""); Serial.print(luzB); Serial.print("\"},");
    Serial.print("\"tiempo_asignado_s\":"); Serial.print(duracionFaseMs / 1000.0, 1); Serial.print(",");
    Serial.print("\"tiempo_restante_s\":"); Serial.print(restanteMs / 1000.0, 1);
  Serial.print("},");

  // Objeto Sensores y Diagnóstico Vía A
  Serial.print("\"via_A\":{");
    Serial.print("\"s1_parada_cm\":"); Serial.print(viaA.distS1, 1); Serial.print(",");
    Serial.print("\"s1_ocupado\":"); Serial.print(viaA.detS1 ? "true" : "false"); Serial.print(",");
    Serial.print("\"s2_cola_cm\":"); Serial.print(viaA.distS2, 1); Serial.print(",");
    Serial.print("\"s2_ocupado\":"); Serial.print(viaA.detS2 ? "true" : "false"); Serial.print(",");
    Serial.print("\"estado_trafico\":\""); Serial.print(viaA.nivelTrafico); Serial.print("\"");
  Serial.print("},");

  // Objeto Sensores y Diagnóstico Vía B
  Serial.print("\"via_B\":{");
    Serial.print("\"s1_parada_cm\":"); Serial.print(viaB.distS1, 1); Serial.print(",");
    Serial.print("\"s1_ocupado\":"); Serial.print(viaB.detS1 ? "true" : "false"); Serial.print(",");
    Serial.print("\"s2_cola_cm\":"); Serial.print(viaB.distS2, 1); Serial.print(",");
    Serial.print("\"s2_ocupado\":"); Serial.print(viaB.detS2 ? "true" : "false"); Serial.print(",");
    Serial.print("\"estado_trafico\":\""); Serial.print(viaB.nivelTrafico); Serial.print("\"");
  Serial.print("},");

  // Objeto Configuración Actual (para sincronizar con el Dashboard)
  Serial.print("\"config\":{");
    Serial.print("\"T_VERDE_VACIO\":"); Serial.print(T_VERDE_VACIO); Serial.print(",");
    Serial.print("\"T_VERDE_APROX\":"); Serial.print(T_VERDE_APROX); Serial.print(",");
    Serial.print("\"T_VERDE_MODERADO\":"); Serial.print(T_VERDE_MODERADO); Serial.print(",");
    Serial.print("\"T_VERDE_CONGESTION\":"); Serial.print(T_VERDE_CONGESTION); Serial.print(",");
    Serial.print("\"T_VERDE_MAX_ABS\":"); Serial.print(T_VERDE_MAX_ABS); Serial.print(",");
    Serial.print("\"T_EXTENSION_ONDA\":"); Serial.print(T_EXTENSION_ONDA); Serial.print(",");
    Serial.print("\"T_AMARILLO\":"); Serial.print(T_AMARILLO); Serial.print(",");
    Serial.print("\"T_DESPEJE_ANTICIP\":"); Serial.print(T_DESPEJE_ANTICIP); Serial.print(",");
    Serial.print("\"UMBRAL_S1_CM\":"); Serial.print(UMBRAL_S1_CM, 1); Serial.print(",");
    Serial.print("\"UMBRAL_S2_CM\":"); Serial.print(UMBRAL_S2_CM, 1);
  Serial.print("}");

  Serial.println("}");
}
