// Buscador del padrón con autocompletar (BuscadorPadron.jsx): las
// sugerencias aparecen mientras se escribe, se eligen con el mouse o el
// teclado, y no se dispara un pedido por cada tecla.
import React, { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BuscadorPadron from '../components/BuscadorPadron.jsx';
import { api } from '../api.js';
import { reiniciarApiFalsa } from './apiFalsa.js';

jest.mock('../api.js', () => require('./apiFalsa.js').crearApiFalsa());

const NICOLAS = { id: 6, cedula: '1031801438', fullName: 'Nicolás Pineda', pollingPlace: 'Puesto Central', votingTable: 'Mesa 1' };
const JHONNY = { id: 8, cedula: '1031138524', fullName: 'Jhonny Mallama', pollingPlace: 'Puesto Norte', votingTable: 'Mesa 2' };

// Como lo usa el Padrón: el campo controlado por el padre.
function Prueba({ onSearch }) {
  const [valor, setValor] = useState('');
  return <BuscadorPadron token="jwt-admin" value={valor} onChange={setValor} onSearch={onSearch} />;
}

function diferida() {
  let resolver;
  const promesa = new Promise((r) => { resolver = r; });
  return { promesa, resolver };
}

const campo = () => screen.getByRole('combobox');
const opciones = () => screen.queryAllByRole('option');

beforeEach(() => reiniciarApiFalsa(api));

it('desde el segundo carácter, al dejar de escribir, sugiere votantes con la parte escrita resaltada', async () => {
  api.suggestVoters.mockResolvedValue({ suggestions: [NICOLAS, JHONNY], total: 2 });
  const usuario = userEvent.setup();
  render(<Prueba onSearch={jest.fn()} />);

  await usuario.type(campo(), '1');
  await new Promise((r) => setTimeout(r, 400));
  expect(api.suggestVoters).not.toHaveBeenCalled();

  await usuario.type(campo(), '031');
  expect(await screen.findByRole('listbox')).toBeInTheDocument();
  // Escribir de corrido es un solo pedido, con todo lo escrito.
  expect(api.suggestVoters).toHaveBeenCalledTimes(1);
  expect(api.suggestVoters).toHaveBeenCalledWith('jwt-admin', '1031');
  expect(campo()).toHaveAttribute('aria-expanded', 'true');

  const primera = opciones()[0];
  expect(primera).toHaveTextContent('1031801438');
  expect(primera).toHaveTextContent('Nicolás Pineda');
  expect(primera).toHaveTextContent('Puesto Central — Mesa 1');
  expect(within(primera).getByText('1031', { selector: 'mark' })).toBeInTheDocument();
});

it('al elegir una con el mouse, completa la cédula, busca ese votante y cierra la lista sin volver a consultar', async () => {
  api.suggestVoters.mockResolvedValue({ suggestions: [NICOLAS, JHONNY], total: 2 });
  const onSearch = jest.fn();
  const usuario = userEvent.setup();
  render(<Prueba onSearch={onSearch} />);
  await usuario.type(campo(), 'pine');
  await screen.findByRole('listbox');

  await usuario.click(opciones()[0]);
  expect(campo()).toHaveValue('1031801438');
  expect(onSearch).toHaveBeenCalledWith('1031801438');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 400));
  expect(api.suggestVoters).toHaveBeenCalledTimes(1);
});

it('con el teclado: las flechas recorren la lista, Enter elige y Escape cierra', async () => {
  api.suggestVoters.mockResolvedValue({ suggestions: [NICOLAS, JHONNY], total: 2 });
  const onSearch = jest.fn();
  const usuario = userEvent.setup();
  render(<Prueba onSearch={onSearch} />);
  await usuario.type(campo(), '1031');
  await screen.findByRole('listbox');

  await usuario.keyboard('{ArrowDown}{ArrowDown}');
  expect(opciones()[1]).toHaveAttribute('aria-selected', 'true');
  expect(campo()).toHaveAttribute('aria-activedescendant', 'sugerencia-1');
  await usuario.keyboard('{ArrowDown}');
  expect(opciones()[0]).toHaveAttribute('aria-selected', 'true');
  await usuario.keyboard('{ArrowUp}{Enter}');
  expect(onSearch).toHaveBeenCalledWith('1031138524');
  expect(campo()).toHaveValue('1031138524');

  await usuario.clear(campo());
  await usuario.type(campo(), '1031');
  await screen.findByRole('listbox');
  await usuario.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

it('dice si nadie coincide, y cuántos más hay cuando son más de 8', async () => {
  api.suggestVoters.mockResolvedValueOnce({ suggestions: [], total: 0 });
  const usuario = userEvent.setup();
  render(<Prueba onSearch={jest.fn()} />);
  await usuario.type(campo(), '99999');
  expect(await screen.findByText('Ningún votante coincide con «99999».')).toBeInTheDocument();

  api.suggestVoters.mockResolvedValueOnce({ suggestions: [NICOLAS], total: 12 });
  await usuario.clear(campo());
  await usuario.type(campo(), '10');
  expect(await screen.findByText('Y 11 más: sigue escribiendo para acotar.')).toBeInTheDocument();
});

it('una respuesta atrasada (de lo que se escribió antes) no reemplaza a la actual', async () => {
  const vieja = diferida();
  api.suggestVoters.mockReturnValueOnce(vieja.promesa).mockResolvedValueOnce({ suggestions: [JHONNY], total: 1 });
  const usuario = userEvent.setup();
  render(<Prueba onSearch={jest.fn()} />);
  await usuario.type(campo(), '10');
  await new Promise((r) => setTimeout(r, 400));
  expect(api.suggestVoters).toHaveBeenCalledWith('jwt-admin', '10');

  await usuario.type(campo(), '31');
  expect(await screen.findByText('Jhonny Mallama', { exact: false })).toBeInTheDocument();
  await act(async () => {
    vieja.resolver({ suggestions: [NICOLAS], total: 1 });
    await vieja.promesa;
  });
  expect(screen.queryByText('Nicolás Pineda', { exact: false })).not.toBeInTheDocument();
  expect(opciones()).toHaveLength(1);
});
