// Etiquetas compartidas entre el editor de admin (ReportsTab) y la vista de
// solo lectura (ReportsViewer), para que ambos describan los widgets/fuentes
// de datos con el mismo texto (incluida la exportación a PDF).
export const WIDGET_TYPE_LABELS = {
  kpi: 'Tarjeta KPI',
  bar: 'Gráfico de barras',
  line: 'Gráfico de línea',
  pie: 'Gráfico de torta',
  table: 'Tabla',
};

export const DATA_SOURCE_LABELS = {
  results: 'Resultados',
  timeseries: 'Evolución de votos en el tiempo',
  participation: 'Participación por puesto, mesa o lugar',
  operational: 'Operación del sistema',
  audit: 'Auditoría',
  concentration: 'Concentración de votos (HHI)',
  participationRate: 'Participación con intervalo de confianza',
  anomalies: 'Anomalías en la evolución de votos',
  turnoutProjection: 'Proyección de participación',
  leadTimeline: 'Momento de definición',
  integrity: 'Integridad del acta',
  suspiciousAccess: 'Accesos sospechosos',
};

// Cómo se puede agrupar la participación (groupBy de analytics-service), y
// el título que propone el panel para cada una.
export const PARTICIPATION_GROUPS = [
  { value: 'polling_place', label: 'Puesto de votación', title: 'Participación por puesto' },
  { value: 'voting_table', label: 'Mesa (de cada puesto)', title: 'Participación por mesa' },
  { value: 'municipio', label: 'Municipio', title: 'Participación por municipio' },
  { value: 'departamento', label: 'Departamento', title: 'Participación por departamento' },
  { value: 'zona', label: 'Zona (urbana o rural)', title: 'Participación por zona' },
];
