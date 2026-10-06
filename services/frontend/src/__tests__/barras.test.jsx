// Gráfico de barras con muchas categorías (components/widgets/barras.js y
// BarChartWidget.jsx): columnas para pocas y cortas, barras horizontales
// ordenadas para muchas o largas, con el nombre recortado y el valor al final.
import { render, screen } from '@testing-library/react';
import BarChartWidget from '../components/widgets/BarChartWidget.jsx';
import { disposicionDeBarras, formatearValor, recortar, FILAS_EN_PDF } from '../components/widgets/barras.js';

// En jsdom nada tiene tamaño: el contenedor de recharts recibe uno fijo.
jest.mock('recharts', () => {
  const real = jest.requireActual('recharts');
  const { cloneElement } = jest.requireActual('react');
  return { ...real, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 400 }) };
});

const puestos = (n) => Array.from({ length: n }, (_, i) => ({ name: `Institución Educativa Número ${i + 1}`, value: i * 5, detail: `${i} de 20` }));

describe('Cómo se dibuja', () => {
  it('pocas categorías cortas: columnas, en su orden', () => {
    const d = disposicionDeBarras([{ name: 'Sí', value: 3 }, { name: 'No', value: 9 }]);
    expect(d).toEqual({ horizontal: false, filas: [{ name: 'Sí', value: 3 }, { name: 'No', value: 9 }], ocultas: 0 });
    expect(disposicionDeBarras([{ name: 'Candidato Demo Tres', value: 5 }, { name: 'Candidato Demo Uno', value: 11 }]).horizontal).toBe(false);
  });

  it('muchas o largas: horizontales, de mayor a menor, con lugar para los nombres y una fila de alto cada una', () => {
    const d = disposicionDeBarras(puestos(20));
    expect(d.horizontal).toBe(true);
    expect(d.filas[0].name).toBe('Institución Educativa Número 20');
    expect(d.filas).toHaveLength(20);
    expect(d.anchoEtiquetas).toBe(180);
    expect(d.letras).toBe(27);
    expect(d.alto).toBe(20 * 26 + 16);
    expect(disposicionDeBarras([{ name: 'Universidad del Valle - Sede Norte', value: 1 }]).horizontal).toBe(true);
  });

  it('en el PDF van las de mayor valor, y se dice cuántas quedaron afuera', () => {
    const d = disposicionDeBarras(puestos(40), { printMode: true });
    expect(d.filas).toHaveLength(FILAS_EN_PDF);
    expect(d.ocultas).toBe(40 - FILAS_EN_PDF);
  });

  it('recorta los nombres largos y escribe los valores en español', () => {
    expect(recortar('Universidad del Valle - Sede Norte', 20)).toBe('Universidad del Val…');
    expect(recortar('Corto', 20)).toBe('Corto');
    // De una mesa, se recorta el puesto y la mesa queda.
    expect(recortar('Escuela Vereda El Salitre · Mesa 3', 24)).toBe('Escuela Vereda… · Mesa 3');
    expect(formatearValor(45.5, '%')).toBe('45,5%');
    expect(formatearValor(1234)).toBe('1.234');
  });
});

it('dibuja las barras horizontales con el nombre recortado y el valor al final', () => {
  render(<BarChartWidget items={[{ name: 'Universidad del Valle - Sede Norte', value: 45.5 }, ...puestos(8)]} unit="%" />);
  // El nombre completo queda como título del texto (al pasar el mouse).
  expect(screen.getByText('Universidad del Valle - Se…')).toBeInTheDocument();
  expect(screen.getByText('Universidad del Valle - Sede Norte', { selector: 'title' })).toBeInTheDocument();
  expect(screen.getByText('45,5%')).toBeInTheDocument();
  expect(screen.getByText('35%')).toBeInTheDocument();
});

it('en el PDF, con muchas, avisa que la tabla las trae todas', () => {
  render(<BarChartWidget items={puestos(20)} printMode />);
  expect(screen.getByText('Y 5 más, con menos: la tabla los trae todos.')).toBeInTheDocument();
});

it('sin datos, el mensaje de la fuente', () => {
  render(<BarChartWidget items={[]} emptyMessage="Todavía no hay votos en esta elección." />);
  expect(screen.getByText('Todavía no hay votos en esta elección.')).toBeInTheDocument();
});
