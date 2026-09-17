import React, { useState } from 'react';
import LoginScreen from './pages/LoginScreen.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import VoterDashboard from './pages/VoterDashboard.jsx';

// Sesión guardada SOLO en memoria (estado de React), nunca en localStorage:
// evita dejar un JWT de votante persistido en el navegador de un equipo
// compartido después de cerrar la pestaña. Recargar la página cierra sesión
// por diseño, algo razonable para una jornada de votación en un puesto físico.
export default function App() {
  const [session, setSession] = useState(null); // { role, token }

  if (!session) {
    return <LoginScreen onLogin={setSession} />;
  }

  if (session.role === 'admin') {
    return <AdminDashboard session={session} onLogout={() => setSession(null)} />;
  }

  return <VoterDashboard session={session} onLogout={() => setSession(null)} />;
}
