import { Routes, Route } from 'react-router-dom';
import NotesListPage from './pages/NotesListPage';
import NoteDetailPage from './pages/NoteDetailPage';
import { useCurrentUser, FAKE_USERS } from './auth/CurrentUserContext';
import { OfflineBanner } from './components/OfflineBanner';
import { useReplayOnReconnect } from './offline/useReplayOnReconnect';
import { useFlushOnRouteChange } from './telemetry/useFlushOnRouteChange';
import { RequirePermission } from './auth/RequirePermission';
import { hasValidSession } from './auth/permissions';

function App() {
  const { currentUser, setCurrentUserId } = useCurrentUser();
  useReplayOnReconnect();
  useFlushOnRouteChange();

  return (
    <div>
      <OfflineBanner />
      <div
        style={{
          padding: '12px 24px',
          background: 'var(--navy-900)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 20, fontWeight: 600 }}>
          soulside <span style={{ color: 'var(--amber-500)' }}>notes</span>
        </span>
        <label style={{ fontSize: 13 }}>
          Acting as:{' '}
          <select
            value={currentUser.id}
            onChange={(e) => setCurrentUserId(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              border: 'none',
              fontFamily: "'Poppins', sans-serif",
            }}
          >
            {FAKE_USERS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.role})
              </option>
            ))}
          </select>
        </label>
      </div>
      <RequirePermission
        check={hasValidSession}
        deniedMessage="Your session role could not be verified. Please sign in again."
      >
        <Routes>
          <Route path="/" element={<NotesListPage />} />
          <Route path="/notes/:id" element={<NoteDetailPage />} />
        </Routes>
      </RequirePermission>
    </div>
  );
}

export default App;