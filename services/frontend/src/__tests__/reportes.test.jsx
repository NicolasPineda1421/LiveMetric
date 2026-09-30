// Reportes: la vista de solo lectura del auditor y los textos de la
// exportación a PDF.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReportsViewer from '../pages/ReportsViewer.jsx';
import { buildIntro, slugify } from '../utils/exportDashboardPdf.js';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const SESION = { role: 'auditor', token: 'jwt-auditor', username: 'auditora' };
const TABLERO = {
  id: 5,
  name: 'Tablero de cierre',
  layout: { widgets: [{ id: 'a', type: 'kpi', title: 'Total', dataSource: 'results', params: {}, grid: { x: 0, y: 0, w: 4, h: 2 } }] },
};

beforeEach(() => reiniciarApiFalsa(api));

describe('vista de reportes del auditor', () => {
  async function abrirTablero() {
    api.listAllElections.mockResolvedValue([{ id: 3, title: 'Consejo', status: 'certified' }]);
    api.listDashboards.mockResolvedValue({ dashboards: [{ id: 5, name: 'Tablero de cierre' }] });
    api.getDashboard.mockResolvedValue(TABLERO);
    api.getResults.mockResolvedValue({ totalVotes: 42, results: [] });
    const usuario = userEvent.setup();
    render(<ReportsViewer session={SESION} />);
    await usuario.selectOptions(await screen.findByRole('combobox'), '3');
    await screen.findByRole('option', { name: 'Tablero de cierre' });
    await usuario.selectOptions(screen.getAllByRole('combobox')[1], '5');
    return usuario;
  }

  it('muestra el tablero elegido con sus datos', async () => {
    await abrirTablero();
    expect(api.listDashboards).toHaveBeenCalledWith('jwt-auditor', '3');
    expect(api.getDashboard).toHaveBeenCalledWith('jwt-auditor', 5);
    expect(await screen.findByText('42')).toBeInTheDocument();
  });

  it('es de solo lectura: ni guardar, ni borrar, ni configurar, mover o quitar widgets', async () => {
    await abrirTablero();
    await screen.findByText('42');
    // react-grid-layout marca con "react-draggable" los widgets que se pueden
    // arrastrar, y a los que no se pueden redimensionar les oculta el
    // tirador con "react-resizable-hide".
    const widgets = document.querySelectorAll('.react-grid-item');
    expect(widgets).toHaveLength(1);
    for (const w of widgets) {
      expect(w).not.toHaveClass('react-draggable');
      expect(w).toHaveClass('react-resizable-hide');
    }
    expect(screen.queryByRole('button', { name: /Guardar|Eliminar|Borrar/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Configurar')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Quitar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Exportar PDF/ })).toBeInTheDocument();
    expect(api.updateDashboard).not.toHaveBeenCalled();
    expect(api.deleteDashboard).not.toHaveBeenCalled();
  });

  it('una elección sin tableros lo dice', async () => {
    api.listAllElections.mockResolvedValue([{ id: 3, title: 'Consejo', status: 'active' }]);
    api.listDashboards.mockResolvedValue({ dashboards: [] });
    const usuario = userEvent.setup();
    render(<ReportsViewer session={SESION} />);
    await usuario.selectOptions(await screen.findByRole('combobox'), '3');
    expect(await screen.findByText('Aún no hay tableros para esta elección.')).toBeInTheDocument();
  });
});

describe('textos de la exportación a PDF', () => {
  it('la introducción aclara que no reemplaza el acta oficial', () => {
    const texto = buildIntro('Cierre', { title: 'Consejo', status: 'certified' }, [
      { dataSource: 'results' },
      { dataSource: 'integrity' },
      { dataSource: 'results' },
    ]);
    expect(texto).toContain('tablero de reportes "Cierre" para la elección "Consejo" (estado: certified)');
    expect(texto).toContain('Incluye 3 widgets con datos de: Resultados, Integridad del acta.');
    expect(texto).toContain('no reemplazan el acta oficial de escrutinio');
  });

  it('sin elección ni widgets, la introducción sigue siendo correcta', () => {
    expect(buildIntro('Vacío', null, [])).toContain('para la elección seleccionada, generado desde el panel de LiveMetric. Incluye 0 widgets.');
  });

  it('el nombre del archivo queda sin tildes, espacios ni caracteres raros', () => {
    expect(slugify('Participación por Mesa — Cierre 2026')).toBe('participacion-por-mesa-cierre-2026');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('¡¡!!')).toBe('tablero');
    expect(slugify('')).toBe('tablero');
  });
});
