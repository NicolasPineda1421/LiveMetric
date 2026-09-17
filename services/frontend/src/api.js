// Cliente HTTP mínimo: envuelve fetch, adjunta el token cuando existe, y
// normaliza los errores del backend (que siempre responden { error: "..." }).

const cfg = window.__LIVEMETRIC_CONFIG__ || {};

const BASE_URLS = {
  auth: cfg.AUTH_URL || 'http://localhost:3001',
  voting: cfg.VOTING_URL || 'http://localhost:3002',
  analytics: cfg.ANALYTICS_URL || 'http://localhost:3003',
  scrutiny: cfg.SCRUTINY_URL || 'http://localhost:3004',
};

async function request(service, path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${BASE_URLS[service]}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    throw new Error(
      `No se pudo contactar el servicio "${service}". ¿Está corriendo el stack con docker compose?`
    );
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // respuesta sin cuerpo (poco común, pero no debe romper el flujo)
  }

  if (!response.ok) {
    throw new Error(data?.error || `Error ${response.status} en ${service}${path}`);
  }
  return data;
}

export const api = {
  // Auth
  loginAdmin: (username, password) =>
    request('auth', '/login/admin', { method: 'POST', body: { username, password } }),
  loginVoter: (cedula, password) =>
    request('auth', '/login/voter', { method: 'POST', body: { cedula, password } }),
  createAdminUser: (token, username, password) =>
    request('auth', '/admin/users', { method: 'POST', token, body: { username, password } }),
  uploadVoters: (token, voters) =>
    request('auth', '/admin/voters/bulk', { method: 'POST', token, body: { voters } }),
  listVoters: (token, limit = 100, offset = 0) =>
    request('auth', `/admin/voters?limit=${limit}&offset=${offset}`, { token }),
  listAuditLog: (token, limit = 50, offset = 0) =>
    request('auth', `/admin/audit-log?limit=${limit}&offset=${offset}`, { token }),

  // Voting
  createTemplate: (token, name, description, templateType, options) =>
    request('voting', '/admin/templates', { method: 'POST', token, body: { name, description, templateType, options } }),
  listTemplates: (token) => request('voting', '/admin/templates', { token }),
  createElection: (token, templateId, title, scheduledStart, scheduledEnd) =>
    request('voting', '/admin/elections', {
      method: 'POST',
      token,
      body: { templateId, title, scheduledStart, scheduledEnd },
    }),
  listAllElections: (token) => request('voting', '/admin/elections', { token }),
  stopElection: (token, electionId) => request('voting', `/admin/elections/${electionId}/stop`, { method: 'POST', token }),
  listActiveElections: () => request('voting', '/elections/active'),
  castVote: (token, electionId, optionId) =>
    request('voting', '/vote', { method: 'POST', token, body: { electionId, optionId } }),

  // Analytics
  getResults: (token, electionId) => request('analytics', `/api/elections/${electionId}/results`, { token }),

  // Scrutiny
  getCertification: (token, electionId) => request('scrutiny', `/certifications/${electionId}`, { token }),
  verifyChain: (token) => request('scrutiny', '/verify', { token }),
  // Descarga binaria (PDF), no pasa por request(): necesita leer un blob,
  // no un JSON, y disparar la descarga en el navegador con el nombre correcto.
  downloadActaPdf: async (token, electionId) => {
    const url = `${BASE_URLS.scrutiny}/certifications/${electionId}/acta.pdf`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      let message = `Error ${response.status} al generar el acta`;
      try {
        const data = await response.json();
        if (data?.error) message = data.error;
      } catch {
        // el cuerpo de error tampoco era JSON; se usa el mensaje genérico
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `acta-escrutinio-eleccion-${electionId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
  },
};
