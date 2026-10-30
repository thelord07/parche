import { Route, Routes } from 'react-router-dom';
import { AuthTokenPage } from './pages/auth-token.tsx';
import { EntrarPage } from './pages/entrar.tsx';
import { InicioPage } from './pages/inicio.tsx';
import { InvitarPage } from './pages/invitar.tsx';
import { NuevoPage } from './pages/nuevo.tsx';
import { UnisrsePage } from './pages/unirse.tsx';

export function App() {
  return (
    <Routes>
      <Route path="/entrar" element={<EntrarPage />} />
      <Route path="/auth/:token" element={<AuthTokenPage />} />
      <Route path="/j/:codigo" element={<UnisrsePage />} />
      <Route path="/" element={<InicioPage />} />
      <Route path="/nuevo" element={<NuevoPage />} />
      <Route path="/g/:slug/invitar" element={<InvitarPage />} />
    </Routes>
  );
}
