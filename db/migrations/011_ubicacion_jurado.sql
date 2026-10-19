-- Migración 011: dónde vive cada jurado de mesa.
--
-- Un jurado solo puede ser de un puesto cerca de donde vive: del mismo
-- municipio y, si el puesto tiene localidad, de la misma localidad (ver
-- cercaDelPuesto en services/auth/src/divipola.js). Se guarda su municipio
-- (con el código del DANE) y su localidad, CIFRADOS como su puesto y su mesa:
-- dicen dónde vive una persona. Un JSON cifrado con la misma clave del
-- padrón (services/auth/src/voterCrypto.js).
--
-- Los jurados que ya existían quedan sin ubicación: siguen autorizando en su
-- mesa, y el panel la pide antes de cambiarles la mesa.
--
-- Es seguro re-ejecutarlo.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS ubicacion TEXT;
