import { Routes, Route } from 'react-router-dom';
import NotesListPage from './pages/NotesListPage';
import NoteDetailPage from './pages/NoteDetailPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<NotesListPage />} />
      <Route path="/notes/:id" element={<NoteDetailPage />} />
    </Routes>
  );
}

export default App;