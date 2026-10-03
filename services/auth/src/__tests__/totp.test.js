// TOTP (totp.js): se prueba contra los vectores del RFC 6238 y en los
// casos que importan para la seguridad: el margen de ±30 s y que un código
// no sirva dos veces.
const totp = require('../totp');

// Secreto del apéndice B del RFC 6238 (SHA-1): los 20 bytes ASCII
// "12345678901234567890". El RFC da los códigos de 8 dígitos; los de 6 son
// sus últimos 6.
const SECRETO_RFC = totp.base32Encode(Buffer.from('12345678901234567890'));
const VECTORES = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(VECTORES)('en t=%i s el código es %s', (segundos, codigo) => {
    expect(totp.codeAt(SECRETO_RFC, totp.currentStep(segundos * 1000))).toBe(codigo);
  });

  it('base32 ida y vuelta, sin importar espacios ni minúsculas', () => {
    const bytes = Buffer.from('cualquier secreto de prueba');
    const texto = totp.base32Encode(bytes);
    expect(totp.base32Decode(texto)).toEqual(bytes);
    expect(totp.base32Decode(texto.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(bytes);
    expect(() => totp.base32Decode('NO-ES-BASE32-018')).toThrow();
  });

  it('genera secretos distintos de 160 bits (32 caracteres base32)', () => {
    const a = totp.generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(totp.generateSecret()).not.toBe(a);
  });

  it('acepta el código actual y los de ±30 s, pero no los de más lejos', () => {
    const secreto = totp.generateSecret();
    const ahora = 1_800_000_000_000;
    const paso = totp.currentStep(ahora);
    expect(totp.verify(secreto, totp.codeAt(secreto, paso), { now: ahora })).toBe(paso);
    expect(totp.verify(secreto, totp.codeAt(secreto, paso - 1), { now: ahora })).toBe(paso - 1);
    expect(totp.verify(secreto, totp.codeAt(secreto, paso + 1), { now: ahora })).toBe(paso + 1);
    expect(totp.verify(secreto, totp.codeAt(secreto, paso - 2), { now: ahora })).toBeNull();
    expect(totp.verify(secreto, totp.codeAt(secreto, paso + 2), { now: ahora })).toBeNull();
  });

  it('un código ya usado (o uno anterior) no vuelve a servir', () => {
    const secreto = totp.generateSecret();
    const ahora = 1_800_000_000_000;
    const paso = totp.currentStep(ahora);
    const codigo = totp.codeAt(secreto, paso);
    expect(totp.verify(secreto, codigo, { now: ahora, lastStep: paso })).toBeNull();
    expect(totp.verify(secreto, totp.codeAt(secreto, paso - 1), { now: ahora, lastStep: paso })).toBeNull();
    // El último paso llega de PostgreSQL (BIGINT) como texto.
    expect(totp.verify(secreto, codigo, { now: ahora, lastStep: String(paso - 1) })).toBe(paso);
  });

  it('rechaza lo que no es un código de 6 dígitos', () => {
    const secreto = totp.generateSecret();
    for (const malo of ['', '12345', '1234567', 'abcdef', null, undefined, 123456]) {
      expect(totp.verify(secreto, malo)).toBeNull();
    }
  });

  it('el QR lleva el secreto, el emisor y la cuenta', () => {
    const uri = totp.otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'Votante ···0001' });
    expect(uri.startsWith('otpauth://totp/LiveMetric:Votante%20%C2%B7%C2%B7%C2%B70001?')).toBe(true);
    const parametros = new URL(uri).searchParams;
    expect(parametros.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(parametros.get('issuer')).toBe('LiveMetric');
    expect(parametros.get('digits')).toBe('6');
    expect(parametros.get('period')).toBe('30');
  });
});
