// Matchers de Testing Library para el DOM (toBeInTheDocument,
// toBeDisabled, toHaveClass...), disponibles en todas las pruebas.
import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'util';

// El jsdom de Jest 29 no trae TextEncoder, que jsPDF usa al cargarse (lo
// importan los tableros de reportes, aunque las pruebas no exporten PDF).
Object.assign(globalThis, { TextEncoder, TextDecoder });
