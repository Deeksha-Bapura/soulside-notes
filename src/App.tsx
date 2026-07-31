import { Routes, Route } from 'react-router-dom';
import NotesListPage from './pages/NotesListPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<NotesListPage />} />
    </Routes>
  );
}

export default App;