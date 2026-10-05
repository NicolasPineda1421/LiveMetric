// Descarga un texto armado en el navegador (la plantilla del padrón, la
// lista de PIN) como un archivo, sin pasar por ningún servidor.
export function descargarTexto(nombre, texto, tipo = 'text/csv;charset=utf-8') {
  const url = window.URL.createObjectURL(new Blob([texto], { type: tipo }));
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  window.URL.revokeObjectURL(url);
}
