import { Routes, Route } from 'react-router-dom';
import NotesListPage from './pages/NotesListPage';
import NoteDetailPage from './pages/NoteDetailPage';
import { useCurrentUser, FAKE_USERS } from './auth/CurrentUserContext';

function App() {
  const { currentUser, setCurrentUserId } = useCurrentUser();

  return (
    <div>
      <div style={{ padding: '8px 20px', background: '#f4f4f4', borderBottom: '1px solid #ddd' }}>
        Acting as:{' '}
        <select
          value={currentUser.id}
          onChange={(e) => setCurrentUserId(e.target.value)}
        >
          {FAKE_USERS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName} ({u.role})
            </option>
          ))}
        </select>
      </div>
      <Routes>
        <Route path="/" element={<NotesListPage />} />
        <Route path="/notes/:id" element={<NoteDetailPage />} />
      </Routes>
    </div>
  );
}

export default App;