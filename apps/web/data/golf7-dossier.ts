import type { ModelDossier } from "@deepblue/core";

/**
 * Volkswagen Golf VII (2012–2019) — seed dossier, researched and reviewed
 * 2026-07-07. Sources cited per issue. The automated dossier builder
 * (Claude + web research at runtime) will produce this same shape.
 */
export const golf7Dossier: ModelDossier = {
  make: "Volkswagen",
  model: "Golf",
  generation: "VII (2012–2019)",
  knownIssues: [
    {
      title: "DSG DQ200 (7 vel., embrague seco): tirones y fallos de mecatrónica",
      description:
        "El DSG de 7 velocidades y embrague seco que montan los Golf VII de menor potencia (1.2/1.4 TSI, 1.6 TDI) es la variante DSG más problemática: tirones y dudas a baja velocidad, y fallos de embrague o mecatrónica típicamente entre 60.000 y 80.000 km, sobre todo en unidades tempranas. Requiere cambio de aceite específico DSG cada ~40.000 km y actualizaciones de software.",
      applicability: { gearbox: "automatic", kmMin: 60_000 },
      typicalRepairCostEur: { min: 1_500, max: 2_500 },
      evidence: [
        "Factura de cambio de aceite DSG (cada ~40.000 km)",
        "Actualizaciones de software DSG en servicio oficial",
        "Prueba dinámica: sin tirones al arrancar ni cambiar a baja velocidad",
      ],
      sellerQuestions: [
        "¿Es cambio manual o automático DSG?",
        "¿Tiene facturas del mantenimiento del DSG (aceite cada ~40.000 km)?",
        "¿Da tirones o duda al arrancar en primera o en atascos?",
      ],
      severity: "major",
      sources: [
        "https://cararac.com/blog/vw-golf-mk7-dsg-reliability-problems.html",
        "https://www.autodoc.co.uk/info/vw-golf-mk7-common-problems-faults-malfunctions-and-reliability",
        "https://www.carsa.co.uk/blog/is-the-volkswagen-golf-reliable-used-buyer-guide",
      ],
    },
    {
      title: "Consumo de aceite en 1.2/1.4 TSI fabricados antes de mediados de 2014",
      description:
        "Los EA211 tempranos (hasta mediados de 2014) heredaron una debilidad de segmentos de pistón del EA111: el puente entre segmentos puede agrietarse, dañando segmentos y cilindros. Motores afectados consumen 500 ml o más cada 1.000 km. Corregido en producción desde mediados de 2014.",
      applicability: { fuel: "gasoline", yearMax: 2014 },
      typicalRepairCostEur: { min: 2_000, max: 4_000 },
      evidence: [
        "Preguntar consumo de aceite entre revisiones (rellenos cada 1.000 km = mala señal)",
        "Historial: motor reparado o pistones sustituidos en campaña",
      ],
      sellerQuestions: [
        "¿Consume aceite entre revisiones? ¿Cada cuánto hay que rellenar?",
      ],
      severity: "major",
      sources: [
        "https://www.carsa.co.uk/blog/is-the-volkswagen-golf-reliable-used-buyer-guide",
        "https://www.pistonheads.com/gassing/topic.asp?h=0&f=255&t=1886914",
      ],
    },
    {
      title: "Desgaste de balancines en 1.4 TSI con desconexión de cilindros (ACT, 140/150 CV)",
      description:
        "Las versiones 140/150 CV con Active Cylinder Technology pueden desgastar los balancines del sistema ACT con el tiempo, obligando a sustituir árbol de admisión y taqués. Talleres especializados citan 1.500–3.500 € con correa incluida.",
      applicability: { fuel: "gasoline", kmMin: 80_000, powerCvMin: 138, powerCvMax: 152 },
      typicalRepairCostEur: { min: 1_500, max: 3_500 },
      evidence: [
        "Confirmar si la versión monta ACT (140/150 CV)",
        "Escuchar ruido metálico al ralentí o en carga parcial",
      ],
      sellerQuestions: [
        "¿Qué versión exacta es (potencia en CV)? ¿Tiene desconexión de cilindros (ACT)?",
      ],
      severity: "moderate",
      sources: [
        "https://www.carsa.co.uk/blog/is-the-volkswagen-golf-reliable-used-buyer-guide",
      ],
    },
    {
      title: "Correa de distribución (EA211): sustitución preventiva pendiente",
      description:
        "Los gasolina 1.2/1.4/1.5 del Golf VII llevan correa (no cadena). El motor es robusto, pero en unidades con kilometraje alto hay que verificar si la correa (y bomba de agua) está sustituida; si no, presupuestarla.",
      applicability: { fuel: "gasoline", kmMin: 90_000 },
      typicalRepairCostEur: { min: 400, max: 700 },
      evidence: ["Factura de sustitución de correa de distribución + bomba de agua"],
      sellerQuestions: [
        "¿Está cambiada la correa de distribución? ¿Hay factura?",
      ],
      severity: "moderate",
      sources: [
        "https://www.carsa.co.uk/blog/is-the-volkswagen-golf-reliable-used-buyer-guide",
      ],
    },
    {
      title: "Válvula EGR obstruida en TDI con uso urbano",
      description:
        "El sistema EGR de los EA288 acumula carbonilla con uso mayoritariamente urbano: ralentí inestable, tirones en carga, testigo de motor y finalmente modo emergencia. La limpieza (150–300 €) suele ser temporal; la sustitución con válvula original ronda 600–1.200 € con mano de obra.",
      applicability: { fuel: "diesel", kmMin: 80_000 },
      typicalRepairCostEur: { min: 600, max: 1_200 },
      evidence: [
        "Patrón de uso del vendedor (ciudad vs carretera)",
        "Sin testigos de avería ni modo emergencia; ralentí estable en la prueba",
      ],
      sellerQuestions: [
        "¿El coche se ha usado sobre todo en ciudad o en carretera?",
        "¿Ha dado avisos de motor o entrado en modo emergencia alguna vez?",
      ],
      severity: "moderate",
      sources: [
        "https://www.carchecker.pro/reports/vw_golf_mk7_1.6_tdi.html",
        "https://www.torquecars.com/volkswagen/1-6-tdi-problems.php",
      ],
    },
    {
      title: "Filtro de partículas (DPF) saturado en TDI de trayectos cortos",
      description:
        "El DPF necesita regeneraciones a alta temperatura (15–20 min a 60+ km/h). Unidades usadas casi solo en trayectos cortos no completan regeneraciones: pérdida de potencia, mayor consumo y testigo DPF. El 1.6 TDI genera menos calor de escape que el 2.0, y es aún más sensible.",
      applicability: { fuel: "diesel", kmMin: 60_000 },
      typicalRepairCostEur: { min: 300, max: 1_500 },
      evidence: [
        "Patrón de uso: viajes largos por carretera regulares",
        "Sin avisos recientes de DPF ni regeneraciones constantes",
      ],
      sellerQuestions: [
        "¿Hace viajes largos por carretera con regularidad?",
        "¿Ha dado avisos del filtro de partículas?",
      ],
      severity: "moderate",
      sources: [
        "https://orbimotors.com/news/common-vw-2-0tdi-engine-issues-what-every-owner-should-know/",
        "https://www.carchecker.pro/reports/vw_golf_mk7_2.0_tdi.html",
      ],
    },
  ],
  recalls: [],
  generalNotes: [
    "Los EA211 gasolina llevan correa, no cadena; los fabricados desde mediados de 2014 son en general muy robustos",
    "Los cambios manuales del Golf VII apenas dan problemas; el riesgo de transmisión se concentra en el DSG DQ200",
    "En diésel, pérdida de refrigerante sin fuga visible puede indicar fuga interna del refrigerador EGR",
    "Aire acondicionado: fallos de compresor descritos a partir de ~50.000–70.000 km, sobre todo en GTI/GTD",
    "Freno de mano eléctrico con fallos descritos en uso urbano intensivo",
    "Comprobar campañas de servicio y recalls oficiales con el VIN en un concesionario VW",
  ],
  sources: [
    "https://www.autodoc.co.uk/info/vw-golf-mk7-common-problems-faults-malfunctions-and-reliability",
    "https://cararac.com/blog/vw-golf-mk7-dsg-reliability-problems.html",
    "https://www.carsa.co.uk/blog/is-the-volkswagen-golf-reliable-used-buyer-guide",
    "https://www.carchecker.pro/reports/vw_golf_mk7_1.6_tdi.html",
    "https://www.carchecker.pro/reports/vw_golf_mk7_2.0_tdi.html",
    "https://www.torquecars.com/volkswagen/1-6-tdi-problems.php",
    "https://orbimotors.com/news/common-vw-2-0tdi-engine-issues-what-every-owner-should-know/",
  ],
};
